/**
 * On-disk state and the single-poller lock.
 *
 * Everything lives under `~/.config/opencode/wechat/`:
 *
 *  - `state.json` — bot credentials, long-poll cursor, per-conversation reply
 *    tokens, and the WeChat-conversation → OpenCode-session bindings.
 *  - `lock.json` — who is currently polling, with a heartbeat.
 *
 * The bot token is a credential, so the files are written 0600 and never
 * logged. They are deliberately outside any repository.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { WeixinAccount } from "./ilink.ts"

/**
 * Where the bridge keeps its files.
 *
 * `WECHAT_STATE_DIR` exists for tests and for anyone who wants the credentials
 * somewhere other than the default config directory.
 */
export const STATE_DIR = process.env.WECHAT_STATE_DIR?.trim()
  ? process.env.WECHAT_STATE_DIR.trim()
  : join(homedir(), ".config", "opencode", "wechat")
export const STATE_PATH = join(STATE_DIR, "state.json")
export const LOCK_PATH = join(STATE_DIR, "lock.json")

/** How long a lock may go without a heartbeat before another instance takes over. */
export const LOCK_STALE_MS = 60_000

export interface SessionBinding {
  sessionID: string
  directory: string
  title?: string
  /** Agent last selected for this conversation, when it differs from the default. */
  agent?: string
  /** Model last selected from the phone. */
  model?: { providerID: string; id: string }
  /** Session this conversation was bound to before the last switch. */
  previousSessionID?: string
  /** When the user last chose a session explicitly, for auto-follow to respect. */
  switchedAt?: number
  boundAt: number
}

/** How many handled message ids are remembered for duplicate suppression. */
export const SEEN_MESSAGE_LIMIT = 200

export interface State {
  version: 1
  account?: WeixinAccount
  /** Long-poll cursor: persisted before dispatch so restarts replay, not drop. */
  syncBuf?: string
  /** conversationId → `context_token` of the latest inbound message. */
  contextTokens: Record<string, string>
  /** conversationId → OpenCode session binding. */
  bindings: Record<string, SessionBinding>
  /**
   * Recently handled wire message ids.
   *
   * Duplicate delivery is possible whenever more than one poller is briefly
   * alive (a hot reload overlapping an outgoing plugin instance, or a server
   * redelivery), and a duplicated prompt costs a real model call, so ids are
   * kept until they fall out of the window.
   */
  seenMessages?: string[]
  /**
   * Text that could not be delivered yet, per conversation.
   *
   * Persisted because a plugin reload is a routine event (saving a file is
   * enough) and losing a finished answer to a reload would be invisible to
   * everyone: the agent believes it reported, the user sees nothing.
   */
  pendingOutbound?: Record<string, string[]>
  /** Retry attempt counters for the pending queue, per conversation. */
  pendingOutboundAttempts?: Record<string, number>
  /**
   * The phone's home session.
   *
   * The conversation falls back to this whenever nothing is attached, so a
   * desktop session can be lent to the phone and handed back without the phone
   * ever losing its place.
   */
  channelSessionID?: string
  /** Sessions the phone knows about: created from it, or lent to it. */
  phoneSessions?: string[]
  /** Most recent conversation, used as the default target for proactive sends. */
  lastConversation?: string
  /** Default working directory for sessions created from WeChat. */
  defaultDirectory?: string
  /**
   * `wechat_ask` questions waiting for an answer, per conversation.
   *
   * Persisted because the tool may run in one plugin instance while the poller
   * (the instance that receives the reply) is another: the question and its
   * answer have to travel through the one thing every instance shares.
   */
  pendingQuestions?: Record<string, { text: string; askedAt: number; expiresAt: number }>
  /** Answers written by whichever instance received the reply. */
  questionAnswers?: Record<string, { text: string; answeredAt: number }>
}

const EMPTY_STATE: State = { version: 1, contextTokens: {}, bindings: {} }

/**
 * The last state that was read successfully.
 *
 * A read can fail for reasons that have nothing to do with "no state yet" —
 * EACCES while another instance renames the file, EBUSY, EIO, a torn write.
 * Returning empty state in those cases used to be catastrophic: `updateState`
 * would persist that emptiness and destroy credentials, bindings, the poll
 * cursor and the outbound queue in one go.
 */
let lastGoodState: State | undefined

function normalizeState(parsed: Partial<State>): State {
  return {
    ...EMPTY_STATE,
    ...parsed,
    contextTokens: { ...(parsed.contextTokens ?? {}) },
    bindings: { ...(parsed.bindings ?? {}) },
  }
}

export function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
}

export function readState(): State {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>
    const state = normalizeState(parsed)
    lastGoodState = state
    return state
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing file really is "no state yet".
    if (code === "ENOENT") return normalizeState({})
    if (error instanceof SyntaxError) {
      // Not JSON at all (a torn write from a crash). Keep a copy so nothing is
      // destroyed silently, then start clean.
      try {
        renameSync(STATE_PATH, `${STATE_PATH}.corrupt`)
      } catch {
        // Best effort: the next write replaces it anyway.
      }
      return normalizeState({})
    }
    // One immediate retry: most failures here are a rename race with another
    // instance, which clears within microseconds.
    try {
      const retry = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>
      const state = normalizeState(retry)
      lastGoodState = state
      return state
    } catch {
      // Fall through.
    }
    // Still failing: prefer what we already know over emptiness, and refuse to
    // invent a state when there is nothing to fall back on.
    if (lastGoodState) return lastGoodState
    throw error
  }
}

/** Write the state atomically and privately (0600). */
export function writeState(state: State): void {
  ensureStateDir()
  writePrivate(STATE_PATH, JSON.stringify(state, null, 2))
}

export function writePrivate(path: string, content: string): void {
  ensureStateDir()
  // Unique temp name: several plugin instances share one process, so a
  // PID-based name would let two writers clobber each other's temp file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  try {
    renameSync(tmp, path)
  } catch (error) {
    // A failed rename (a Windows sharing violation while another instance reads
    // the file, or a killed process) must not leave the temp file behind for
    // years — that is how eight of them piled up in the state directory.
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best effort.
    }
    throw error
  }
}

/** How long a `*.tmp` file may sit around before it is considered abandoned. */
const TEMP_FILE_TTL_MS = 5 * 60_000

/**
 * Delete abandoned temp files from the state directory.
 *
 * Called once per plugin load: a process that died between the write and the
 * rename otherwise leaves its temp file in a directory nobody ever cleans.
 */
export function pruneStaleTemps(now: number = Date.now()): number {
  let removed = 0
  try {
    for (const name of readdirSync(STATE_DIR)) {
      if (!name.endsWith(".tmp")) continue
      const path = join(STATE_DIR, name)
      try {
        if (now - statSync(path).mtimeMs < TEMP_FILE_TTL_MS) continue
        rmSync(path, { force: true })
        removed += 1
      } catch {
        // A racing cleanup is fine.
      }
    }
  } catch {
    // No state directory yet.
  }
  return removed
}

/** Small helper for read-modify-write sequences inside the bridge. */
export function updateState(mutate: (state: State) => void): State {
  const state = readState()
  mutate(state)
  writeState(state)
  return state
}

/*
 * ---------------------------------------------------------------------------
 * Lock
 * ---------------------------------------------------------------------------
 */

export interface LockInfo {
  /** Random id for this plugin instance (several instances share one process). */
  instanceId: string
  pid: number
  location: string
  startedAt: number
  /**
   * Last heartbeat: proves the *instance* is alive.
   *
   * Not proof that it is polling — a wedged instance keeps refreshing this.
   */
  heartbeat: number
  /**
   * Last completed long poll, written by the owner.
   *
   * A healthy poller advances this at least once per server timeout (~40s), so
   * a stale value means the owner is wedged and the slot must be stealable.
   * Note that a *client* timeout also advances it (the loop turned over); the
   * field that only moves on a real answer is `answeredAt`.
   */
  polledAt?: number
  /** Last poll the server actually answered, for diagnosing a dead network. */
  answeredAt?: number
  /** Consecutive polls that ended by client timeout. */
  timeouts?: number
}

export interface LockHandle {
  info: LockInfo
  refresh: () => void
  /** Record poller liveness so a wedged owner can be detected from outside. */
  touchPolledAt: (info: { polledAt?: number; answeredAt?: number; timeouts?: number }) => void
  release: () => void
}

/** A lock whose owner has not completed a poll for this long is wedged. */
export const LOCK_POLL_STALE_MS = 120_000

/**
 * Try to become the single poller for this machine.
 *
 * Several plugin instances load at once — one per OpenCode location — and they
 * share a PID, so a PID check alone would let them all poll and every inbound
 * message would be answered as many times as there are open projects. The
 * instance id plus a heartbeat decides ownership, and a stale lock (dead
 * process, or an owner that stopped refreshing) can be taken over.
 *
 * The claim itself uses an exclusive create. A read-then-write claim is not
 * atomic, and two instances ticking in the same millisecond both see a free
 * lock and both write it: they then take turns stealing it from each other and
 * neither ever settles.
 */
export function acquireLock(location: string): LockHandle | undefined {
  ensureStateDir()
  pruneStaleTemps()
  const now = Date.now()

  const info: LockInfo = {
    instanceId: randomUUID(),
    pid: process.pid,
    location,
    startedAt: now,
    heartbeat: now,
  }

  if (!claimExclusively(info)) {
    const current = readLock()
    const pollingAlive = current?.polledAt !== undefined && Date.now() - current.polledAt < LOCK_POLL_STALE_MS
    // A fresh heartbeat with no recent poll means the owner is wedged: stealable.
    const foreignLiveLock = Boolean(
      current &&
        Date.now() - current.heartbeat < LOCK_STALE_MS &&
        !isDeadProcess(current.pid) &&
        (current.polledAt === undefined || pollingAlive),
    )
    if (foreignLiveLock) return undefined

    // Stale lock: drop it, but only if it is still the one we inspected, so a
    // fresh lock claimed in the meantime is not destroyed.
    const latest = readLock()
    if (latest && latest.instanceId !== current?.instanceId) return undefined
    try {
      rmSync(LOCK_PATH, { force: true })
    } catch {
      return undefined
    }
    if (!claimExclusively(info)) return undefined
  }

  const stillOurs = (): boolean => {
    try {
      return readLock()?.instanceId === info.instanceId
    } catch {
      return false
    }
  }

  const refresh = (): void => {
    try {
      // Compare the instance id only: after a laptop sleep the heartbeat is
      // stale but the lock may still name us, and a heartbeat that cannot
      // revive itself would strand the slot (the owner would "lose" a lock
      // nobody else wants, forcing a needless handover).
      if (!stillOurs()) return
      info.heartbeat = Date.now()
      writePrivate(LOCK_PATH, JSON.stringify(info))
    } catch {
      // A failed heartbeat only matters if it persists; the next tick retries.
    }
  }

  const release = (): void => {
    try {
      if (readLock()?.instanceId === info.instanceId) rmSync(LOCK_PATH, { force: true })
    } catch {
      // Best effort: a leftover lock is recovered by the staleness check.
    }
  }

  const touchPolledAt = (info2: { polledAt?: number; answeredAt?: number; timeouts?: number }): void => {
    try {
      if (!stillOurs()) return
      if (info2.polledAt !== undefined) info.polledAt = info2.polledAt
      if (info2.answeredAt !== undefined) info.answeredAt = info2.answeredAt
      if (info2.timeouts !== undefined) info.timeouts = info2.timeouts
      writePrivate(LOCK_PATH, JSON.stringify(info))
    } catch {
      // Best effort: the watchdog on the owner side covers a missed write.
    }
  }

  return { info, refresh, touchPolledAt, release }
}

/** Create the lock file only when it does not exist yet. */
function claimExclusively(info: LockInfo): boolean {
  try {
    writeFileSync(LOCK_PATH, JSON.stringify(info), { flag: "wx", mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    return false
  }
}

/**
 * The instance id currently recorded in the lock file.
 *
 * Callers compare it against their own id instead of trusting a cached
 * "I acquired it once" flag: a hot reload can leave a plugin instance alive
 * long enough to overlap with its replacement, and two pollers on one account
 * means every inbound message is answered twice.
 */
export function lockOwnerInstanceId(): string | undefined {
  const current = readLock()
  if (!current) return undefined
  if (Date.now() - current.heartbeat >= LOCK_STALE_MS) return undefined
  if (isDeadProcess(current.pid)) return undefined
  return current.instanceId
}

function readLock(): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as LockInfo
    return typeof parsed?.instanceId === "string" ? parsed : undefined
  } catch {
    return undefined
  }
}

function isDeadProcess(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return true
  // The lock lives on the same machine as the process, so a signal probe is enough.
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM means the process exists but belongs to someone else.
    return code !== "EPERM"
  }
}
