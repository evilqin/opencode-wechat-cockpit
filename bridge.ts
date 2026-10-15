/**
 * The bridge: WeChat conversations ↔ OpenCode sessions.
 *
 * Responsibilities, in the order they matter:
 *  1. Turn an inbound direct message into a prompt for a bound session, and
 *     carry attachments in both directions.
 *  2. Push what the session produced back to WeChat — one message per turn by
 *     default, optionally live — because WeChat has no message editing, so
 *     token-by-token streaming would be a wall of noise.
 *  3. Relay the two things that block a turn: permission requests and the
 *     agent's interactive questions.
 *  4. Offer enough control to run a session entirely from the phone: new,
 *     list, switch, rename, cancel, model, agent, cost.
 */

import { basename, isAbsolute, join, resolve as resolvePath } from "node:path"
import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { promises as fs, readFileSync, statSync } from "node:fs"

import type * as OpenCodePlugin from "@opencode/plugin"

/** The plugin context type, taken from the host's own definition. */
type Context = OpenCodePlugin.Plugin.Context

import { LocalApi, type ApiSession, type ApiForm } from "./api.ts"
import { HELP_TEXT, renderCommandDoc, renderManual, resolveCommandDoc } from "./manual.ts"
import {
  SendRefusedError,
  notifyStart,
  notifyStop,
  newClientId,
  sendItems,
  sendText,
  getTypingTicket,
  sendTyping,
  textItem,
  redactSecrets,
  type WeixinAccount,
} from "./ilink.ts"
import { ChannelMonitor, conversationKey, type InboundMessage } from "./monitor.ts"
import { downloadItem, prepareAttachment, kindForPath, pruneInbox, type OutboundKind } from "./media.ts"
import {
  DECISION_LABEL,
  MAX_PENDING_PERMISSIONS,
  describeAction,
  formatPendingSummary,
  formatPermissionBatch,
  formatPermissionPrompt,
  parseDecision,
  parseSelector,
  type PendingPermission,
  type PermissionDecision,
} from "./permissions.ts"
import { describeAnswer, formatFormPrompt, resolveAnswer, type PendingForm } from "./forms.ts"
import {
  describeSession,
  formatAgentList,
  formatModelList,
  resolveAgentTarget,
  resolveModelTarget,
  resolveSessionTarget,
  shortDirectory,
  titleFromText,
  unwrapData,
  unwrapList,
  type AgentSummary,
  type ModelSummary,
} from "./sessions.ts"
import {
  acquireLock,
  lockOwnerInstanceId,
  pruneQrPng,
  pruneStaleTemps,
  readState,
  updateState,
  STATE_DIR,
  STATE_PATH,
  SEEN_MESSAGE_LIMIT,
  type LockHandle,
  type QueuedMessage,
  type SessionBinding,
  type State,
} from "./state.ts"
import { configChanged, type WechatConfig } from "./config.ts"

export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
}

/** How often ownership and the heartbeat are re-verified while polling. */
const OWNERSHIP_CHECK_MS = 10_000
/** A monitor with no completed poll for this long is considered stuck. */
const POLL_STALL_MS = 120_000
/** Errcode used for failures that never reached the service. */
const LOCAL_FAILURE = -1
/** Consecutive long polls with no answer before the network is called out in the log. */
const POLL_TIMEOUT_WARN_AFTER = 2
/** Consecutive long polls with no answer before the poller is rebuilt. */
const POLL_TIMEOUT_RESTART_AFTER = 3
/** Minimum spacing between timeout-driven poller rebuilds. */
const POLL_RESTART_COOLDOWN_MS = 5 * 60_000
/** A maintenance tick this late means the process was suspended (lid, standby). */
const SUSPENSION_GAP_MS = 60_000
/** How many queued messages one conversation keeps before the oldest are dropped. */
const QUEUE_LIMIT = 20
/** First characters of the "part of the answer is missing" notice. */
const NOTICE_PREFIX = "⚠️ 上面那条没发完"
/** Hourly retention/expiry chores, run from the ownership tick. */
const HOUSEKEEPING_INTERVAL_MS = 60 * 60_000
/** A parked queue nobody claimed for this long is dropped (it is stale content). */
const PARKED_QUEUE_TTL_MS = 7 * 24 * 60 * 60_000
/** The "typing…" refresh stops itself after this long, whatever happens. */
const TYPING_MAX_MS = 10 * 60_000
/**
 * How recently a flush must have delivered something for `/more` to treat the
 * answer as "already recovered" instead of asking the model to continue.
 */
const MORE_DELIVERY_WINDOW_MS = 15_000
/**
 * What `/more` sends when nothing is queued and the model really did stop.
 *
 * Typing "继续" as an ordinary message makes the model treat it as a fresh
 * question ("继续什么？"); this instruction tells it what actually happened.
 */
const CONTINUE_HINT = [
  "（续写请求）你上一条回答在手机上显示不全、被认为没有写完。请从中断处接着写完剩下的部分：",
  "· 不要重复已经发出的内容",
  "· 不要重新解释问题、不要道歉、不要复述上下文",
  "· 直接从断点续写",
].join("\n")
/** Inbound text beyond this is truncated for the prompt, with a note. */
const MAX_INBOUND_CHARS = 8_000
/** How much of the log `/log` prints. */
const LOG_TAIL_LINES = 40
/** How often pending approvals and questions are re-read from the service. */
const RECONCILE_INTERVAL_MS = 60_000
/** Default wait for a burst of approval requests to finish before announcing. */
const PERMISSION_BURST_MS = 800

/** Turn-local text assembly for one session. */
interface TurnBuffer {
  conversationId: string
  parts: string[]
  timer?: NodeJS.Timeout
}

/** Live streaming state for one session. */
interface LiveBuffer {
  conversationId: string
  pending: string
  sent: number
  /** A fragment handed to the send path but not confirmed yet (in flight). */
  sending?: string
  /** Set when a streamed fragment could not be delivered. */
  degraded?: boolean
  timer?: NodeJS.Timeout
}

/** A question the agent asked and is blocked on. */
const QUESTION_POLL_MS = 3_000

export class Bridge {
  readonly #ctx: Context
  readonly #log: Logger
  readonly #location: string
  readonly #api: LocalApi
  #config: WechatConfig
  #state: State

  #monitor?: ChannelMonitor
  #lock?: LockHandle
  #maintenance?: NodeJS.Timeout
  /** One in-flight auto-follow at a time: a slow API used to overlap them. */
  #following = false
  /** One in-flight reconcile at a time, for the same reason. */
  #reconciling = false
  /** When the hourly chores last ran. */
  #lastHousekeeping = 0
  /** `mtimeMs:size` of the state file at the last (successful) reload. */
  #stateStamp?: string

  #typingTickets = new Map<string, string | undefined>()
  #typingTimers = new Map<string, NodeJS.Timeout>()
  /**
   * Which conversation the "typing…" indicator was turned on for, per session.
   *
   * Kept separately from the text buffers because a turn that produces no text
   * (all tool calls, or an interrupted answer) has no buffer to look the
   * conversation up in — and the refresh timer would then keep the indicator
   * running forever, even while the user is not talking.
   */
  #typingSessions = new Map<string, string>()
  #turns = new Map<string, TurnBuffer>()
  #live = new Map<string, LiveBuffer>()
  /**
   * Sessions whose current turn has already been signalled as finished.
   *
   * A completion signal can arrive before the last text block, so from that
   * point on the turn uses the short settle window instead of the full grace —
   * and a new turn (busy/started) clears the flag again.
   */
  #settledTurns = new Set<string>()
  /** Event types seen once, so a renamed host event is visible in the log. */
  #seenEventTypes = new Set<string>()
  #pendingPermissions: PendingPermission[] = []
  #pendingForms: PendingForm[] = []
  #lastReconcile = 0
  #permissionBurst?: NodeJS.Timeout
  /** Per-conversation send chain, so chunks never interleave. */
  #sendChains = new Map<string, Promise<unknown>>()
  /** When auto-follow last moved each conversation, to avoid flapping. */
  #followed = new Map<string, number>()
  /** Sessions ids as last displayed, so `/attach 3` means what the user saw. */
  #lastListing = new Map<string, string[]>()
  #retryTimers = new Map<string, NodeJS.Timeout>()
  #stopMonitor?: () => void
  /** The token the running monitor started with, for re-login detection. */
  #pollingToken?: string
  /** When the poller was last rebuilt because polls stopped being answered. */
  #lastPollRestart = 0
  /** Previous ownership tick, to notice that the process was suspended. */
  #lastTickAt = 0
  /** When the queue last delivered something, so `/more` can avoid duplicating it. */
  #lastFlushedAt = new Map<string, number>()
  /** Conversations whose queue is being flushed right now, so two flushes cannot race. */
  #flushing = new Set<string>()
  /** Bumped when a queue is dropped, so a flush in flight cannot resurrect it. */
  #queueGenerations = new Map<string, number>()

  constructor(ctx: Context, config: WechatConfig, log: Logger, location: string, api: LocalApi) {
    this.#ctx = ctx
    this.#config = config
    this.#log = log
    this.#location = location
    this.#api = api
    this.#state = readState()
  }

  get state(): State {
    return this.#state
  }

  get config(): WechatConfig {
    return this.#config
  }

  get api(): LocalApi {
    return this.#api
  }

  /** The directory new sessions land in: a `/dir` override wins over config. */
  get defaultDirectory(): string {
    return this.#defaultDirectory()
  }

  setConfig(config: WechatConfig): void {
    if (configChanged(this.#config, config)) {
      this.#config = config
      this.#log.info(`config reloaded (progress=${config.progress} stream=${config.stream} dir=${config.directory})`)
    }
  }

  get account(): WeixinAccount | undefined {
    return this.#state.account
  }

  reloadState(): void {
    // mtime-gated: the ownership tick calls this every 10 s (per loaded project)
    // and every inbound message does too, so parsing an unchanged 13 KB JSON file
    // was pure waste. `statSync` is about two orders of magnitude cheaper.
    try {
      const stats = statSync(STATE_PATH)
      const stamp = `${stats.mtimeMs}:${stats.size}`
      if (this.#stateStamp === stamp) return
      this.#stateStamp = stamp
    } catch {
      // Missing/unreadable file: fall through and let readState decide.
      this.#stateStamp = undefined
    }
    this.#state = readState()
    // Adopt the conversation's session as the home channel when an install
    // predates the channel concept — without this, the first `/detach` would
    // create a second "主会话" instead of returning to the existing one.
    const conversationId = this.#state.lastConversation
    const binding = conversationId ? this.#state.bindings[conversationId] : undefined
    if (!this.#state.channelSessionID && binding?.sessionID) {
      this.#state = updateState((state) => {
        state.channelSessionID = binding.sessionID
        state.phoneSessions = [binding.sessionID, ...(state.phoneSessions ?? [])].slice(0, 50)
      })
    }
  }

  saveAccount(account: WeixinAccount): void {
    this.#state = updateState((state) => {
      state.account = account
    })
  }

  /*
   * -------------------------------------------------------------------------
   * Poller ownership
   * -------------------------------------------------------------------------
   */

  /**
   * Try to become — or stay — the single poller.
   *
   * Called repeatedly. Ownership is verified against the lock file every time,
   * not remembered, because a hot reload can overlap the outgoing and incoming
   * plugin instances: whichever of them keeps claiming the slot from a cached
   * flag would run a second long poll and every inbound message would be
   * handled twice.
   */
  tryBecomeOwner(): boolean {
    if (!this.#lock) {
      const acquired = acquireLock(this.#location)
      if (!acquired) return false
      this.#lock = acquired
      this.reloadState()
      this.#log.info(`instance owns the poller (pid ${process.pid}) id=${acquired.info.instanceId.slice(0, 8)}`)
      this.#maintenance = setInterval(() => this.#maintainOwnership(), OWNERSHIP_CHECK_MS)
      this.#maintenance.unref?.()
    }

    if (this.#lock && !this.#lock.isMine()) {
      this.#log.warn(`poller ownership lost; stopping (mine=${this.#lock.info.instanceId.slice(0, 8)})`)
      this.releaseOwnership()
      return false
    }

    this.startPolling()
    return true
  }

  get ownsPoller(): boolean {
    return Boolean(this.#lock) && this.#lock?.info.instanceId === lockOwnerInstanceId()
  }

  #maintainOwnership(): void {
    try {
      this.reloadState()
      this.#lock?.refresh()
      if (this.#lock && !this.#lock.isMine()) {
        this.#log.warn("lock no longer names this instance; stopping the poller")
        this.releaseOwnership()
        return
      }
      // A tick that arrives this late means the process was suspended (lid
      // closed, connected standby): the held poll is meaningless by now, so
      // rebuild it instead of waiting for the socket to notice.
      const tickedAt = Date.now()
      if (isResumeGap(this.#lastTickAt, tickedAt)) {
        this.#log.info(`resumed after a ${Math.round((tickedAt - this.#lastTickAt) / 1000)}s gap; rebuilding the poller`)
        this.stopPolling({ restart: true })
      }
      this.#lastTickAt = tickedAt
      // A login may have landed after this instance started: pick it up.
      this.startPolling()
      // Watchdog: a held long poll that never returns leaves the loop alive and
      // silent — messages simply stop arriving, with no error to react to. If
      // the monitor has shown no activity for a while, rebuild it.
      // Publish poller liveness into the lock so another instance can tell a
      // working owner from a wedged one, and so `verify.ts` can tell a healthy
      // network from one that is silently dropping traffic: `polledAt` moves on
      // every loop turn (timeouts included), `answeredAt` only on real answers.
      if (this.#monitor) {
        this.#lock?.touchPolledAt({
          polledAt: this.#monitor.lastActivityAt,
          answeredAt: this.#monitor.lastResponseAt,
          timeouts: this.#monitor.consecutiveTimeouts,
        })
      }
      if (this.#monitor && Date.now() - this.#monitor.lastActivityAt > POLL_STALL_MS) {
        this.#log.warn(
          `poller looks stuck (no activity for ${Math.round((Date.now() - this.#monitor.lastActivityAt) / 1000)}s); restarting it`,
        )
        this.stopPolling({ restart: true })
        this.startPolling()
      }
      // Anything the agent is waiting on while this instance restarted must be
      // picked back up, or the question would sit unanswered on the server.
      if (Date.now() - this.#lastReconcile > RECONCILE_INTERVAL_MS && !this.#reconciling) {
        this.#reconciling = true
        void this.reconcilePending()
          .catch((error) => this.#log.warn(`reconcile failed: ${errorText(error)}`))
          .finally(() => {
            this.#reconciling = false
          })
      }
      // Keep the conversation on whatever the desktop is working on.
      if (!this.#following) {
        this.#following = true
        void this.followActiveSession()
          .catch((error) => this.#log.warn(`auto-follow failed: ${errorText(error)}`))
          .finally(() => {
            this.#following = false
          })
      }
      // Hourly chores. They used to run only as side effects of other work, so
      // an idle channel never pruned its inbox, its stale temp files or its
      // expired question records.
      if (Date.now() - this.#lastHousekeeping > HOUSEKEEPING_INTERVAL_MS) {
        this.#lastHousekeeping = Date.now()
        try {
          this.#housekeeping()
        } catch (error) {
          this.#log.warn(`housekeeping failed: ${errorText(error)}`)
        }
      }
    } catch (error) {
      this.#log.warn(`ownership check failed: ${errorText(error)}`)
    }
  }

  /** The hourly chores: retention, expiry, and per-conversation bookkeeping. */
  #housekeeping(): void {
    try {
      pruneInbox()
    } catch (error) {
      this.#log.warn(`inbox prune failed: ${errorText(error)}`)
    }
    try {
      pruneStaleTemps()
    } catch (error) {
      this.#log.warn(`temp prune failed: ${errorText(error)}`)
    }
    // A QR bitmap left behind by an abandoned login is a scannable credential.
    if (pruneQrPng()) this.#log.info("removed a stale login QR image")
    // A channel that goes quiet used to keep expired question records forever:
    // the sweep only ran from `handleInbound`.
    this.#sweepStaleQuestions()
    this.#expireParkedQueues()
    this.#pruneConversationState()
  }

  /**
   * Drop parked queues that nobody ever fetched.
   *
   * After the backoff runs out the text waits for the next inbound message; if
   * the user never comes back it would sit in the state file forever (up to
   * `QUEUE_LIMIT × chunkSize` per conversation).
   */
  #expireParkedQueues(): void {
    const now = Date.now()
    for (const [conversationId, items] of Object.entries(this.#state.pendingOutbound ?? {})) {
      if (items.length === 0) continue
      const since = this.#state.pendingOutboundSince?.[conversationId]
      if (since === undefined || now - since < PARKED_QUEUE_TTL_MS) continue
      const backoff = this.#config.retryBackoffMs
      if (this.#retryAttempt(conversationId) < Math.max(backoff.length, 1)) continue
      this.#log.warn(
        `dropping ${items.length} parked message(s) for ${conversationId}: unclaimed for ${Math.round(
          (now - since) / 86_400_000,
        )} day(s)`,
      )
      this.#dropQueue(conversationId)
    }
  }

  /**
   * Forget per-conversation bookkeeping for conversations that no longer exist.
   *
   * These maps are keyed by "conversations that ever existed", so a deleted
   * session or a `/switch` left an entry behind for the life of the process.
   */
  #pruneConversationState(): void {
    const live = new Set(Object.keys(this.#state.bindings))
    if (this.#state.lastConversation) live.add(this.#state.lastConversation)
    const maps: Array<Map<string, unknown>> = [
      this.#typingTickets,
      this.#typingTimers,
      this.#typingSessions,
      this.#sendChains,
      this.#lastListing,
      this.#lastFlushedAt,
      this.#queueGenerations,
    ]
    for (const map of maps) {
      for (const key of [...map.keys()]) {
        if (!live.has(key)) map.delete(key)
      }
    }
    for (const sessionID of [...this.#settledTurns]) {
      if (!live.has(sessionID)) this.#settledTurns.delete(sessionID)
    }
    // Approval/form records belong to a session; a conversation that is gone
    // cannot answer them.
    this.#pendingPermissions = this.#pendingPermissions.filter((item) => live.has(item.conversationId))
    this.#pendingForms = this.#pendingForms.filter((item) => live.has(item.conversationId))
  }

  /**
   * Re-register pending approvals and questions from the service.
   *
   * The bridge's queues live in memory, so a plugin reload — or any restart of
   * the poller — forgets what the agent is blocked on: the request still exists
   * on the server, but an answer from the phone would be rejected with "nothing
   * is waiting". Re-reading them on a slow timer makes the channel self-healing.
   */
  async reconcilePending(): Promise<void> {
    if (!this.#api.available) return
    this.#lastReconcile = Date.now()

    const conversationFor = (sessionID: string): string | undefined => {
      for (const [conversationId, binding] of Object.entries(this.#state.bindings)) {
        if (binding.sessionID === sessionID) return conversationId
      }
      return undefined
    }

    for (const [conversationId, binding] of Object.entries(this.#state.bindings)) {
      const forms = await this.#api.listForms(binding.sessionID)
      for (const form of forms) {
        if (form.state && form.state.status !== "pending") continue
        if (this.#pendingForms.some((item) => item.formID === form.id)) continue
        const pending: PendingForm = {
          conversationId,
          sessionID: form.sessionID,
          formID: form.id,
          title: form.title,
          fields: form.fields ?? [],
          createdAt: Date.now(),
        }
        this.#pendingForms.push(pending)
        const queue = this.#pendingForms.filter((item) => item.conversationId === conversationId)
        this.#log.info(`re-registered pending form ${form.id}`)
        await this.#send(
          conversationId,
          `（这条提问还在等你回答）\n${formatFormPrompt(pending, queue.indexOf(pending) + 1, queue.length)}`,
        )
      }
    }

    for (const request of await this.#api.listPermissionRequests()) {
      const sessionID = typeof request.sessionID === "string" ? request.sessionID : ""
      const id = typeof request.id === "string" ? request.id : ""
      const conversationId = sessionID ? conversationFor(sessionID) : undefined
      if (!id || !conversationId) continue
      if (this.#pendingPermissions.some((item) => item.requestID === id)) continue
      const pending: PendingPermission = {
        conversationId,
        sessionID,
        requestID: id,
        action: typeof request.action === "string" ? request.action : "?",
        resources: Array.isArray(request.resources) ? request.resources.map(String) : [],
        createdAt: Date.now(),
      }
      this.#pendingPermissions.push(pending)
      const queue = this.#pendingPermissions.filter((item) => item.conversationId === conversationId)
      this.#log.info(`re-registered pending permission ${id}`)
      await this.#send(
        conversationId,
        `（这条审批还在等你回复）\n${formatPermissionPrompt(pending, queue.indexOf(pending) + 1, queue.length)}`,
      )
    }

    // Reap approvals whose session no longer exists. They cannot be answered —
    // `permission.reply` fails — and they keep occupying an index, so a genuine
    // new approval behind them looked unanswerable.
    for (const item of [...this.#pendingPermissions]) {
      const session = await this.#ctx.session.get({ sessionID: item.sessionID }).catch(() => undefined)
      if (session) continue
      this.#pendingPermissions = this.#pendingPermissions.filter((entry) => entry !== item)
      this.#log.info(`dropped approval ${item.requestID}: its session no longer exists`)
      await this.#send(
        item.conversationId,
        `ℹ️ 有一个待审批（${describeAction(item.action)}）的会话已经被删掉了，已从列表移除。`,
      )
    }
  }

  releaseOwnership(): void {
    this.stopPolling()
    if (this.#maintenance) clearInterval(this.#maintenance)
    this.#maintenance = undefined
    this.#lock?.release()
    this.#lock = undefined
  }

  /** Start the poller when this instance owns the slot. Safe to call repeatedly. */
  startPolling(): void {
    if (!this.#lock || this.#lock.info.instanceId !== lockOwnerInstanceId()) return

    const account = this.#state.account
    if (!account?.token) {
      // Logged out (or the token was cleared): nothing to poll, and a monitor
      // still holding the old credential must not keep running.
      if (this.#monitor) {
        this.#log.info("no token; stopping the poller")
        this.stopPolling()
      }
      return
    }

    // A re-login replaces the token. The running monitor holds the old one, so
    // rebuild it rather than let it poll with a revoked credential (the server
    // would reject it and the handler might wipe the fresh token).
    if (this.#monitor && this.#pollingToken !== account.token) {
      this.#log.info("token changed; rebuilding the poller")
      this.stopPolling({ restart: true })
    }
    if (this.#monitor) return

    const controller = new AbortController()
    this.#stopMonitor = () => controller.abort()
    this.#pollingToken = account.token

    const monitor = new ChannelMonitor({
      account,
      initialSyncBuf: this.#state.syncBuf,
      onSyncBuf: (buf) => {
        // Only write when the cursor actually moved: the poll answer repeats the
        // same cursor often, and each write rewrites the whole state file.
        if (this.#state.syncBuf === buf) return
        this.#state = updateState((state) => {
          state.syncBuf = buf
        })
        this.#stateStamp = undefined
      },
      onMessage: (message) => this.handleInbound(message),
      onError: (error) => this.#log.warn(`poll: ${errorText(error)}`),
      onTimeout: (consecutive) => this.#handlePollTimeout(consecutive),
      onRecovered: (timeouts) => this.#log.info(`poll answers resumed after ${timeouts} timeout(s)`),
      shouldContinue: () => this.ownsPoller,
      onStop: (reason, detail) => {
        this.#log.warn(`poll stopped: ${reason}${detail ? ` (${detail})` : ""}`)
        if (reason === "stale-token") this.#handleStaleToken(account.token)
      },
    })

    this.#monitor = monitor
    this.#log.info(`poller started for ${account.accountId} via ${account.baseUrl}`)
    void notifyStart(account).catch((error) => this.#log.warn(`notifystart failed: ${errorText(error)}`))

    const forget = (): void => {
      // Release the slot so the next ownership tick can start a fresh poller: a
      // monitor that exited on its own used to keep `#monitor` set forever, so
      // a re-login waited ~2 minutes for the stall watchdog.
      if (this.#monitor !== monitor) return
      this.#monitor = undefined
      this.#stopMonitor = undefined
      this.#pollingToken = undefined
    }
    void monitor
      .run(controller.signal)
      .then((reason) => {
        forget()
        this.#log.info(`poller exited: ${reason}`)
      })
      .catch((error) => {
        forget()
        this.#log.warn(`poller crashed: ${errorText(error)}`)
      })
  }

  /**
   * A long poll was sent and nothing came back within the client budget.
   *
   * A healthy poll is always answered — the server's own timeout is shorter
   * than ours — so a timeout means the path is dropping traffic (a portal that
   * logged out, a stale NAT entry, a Wi-Fi link that only looks connected).
   * Without this, the channel just goes quiet: the loop keeps cycling, no error
   * is raised, and the stall watchdog sees "activity" in every silent timeout.
   * After a few of those, rebuild the poller: a fresh socket recovers states a
   * held connection cannot.
   */
  #handlePollTimeout(consecutive: number): void {
    if (consecutive === POLL_TIMEOUT_WARN_AFTER) {
      this.#log.warn(`${consecutive} long polls got no answer; the network may be dropping traffic`)
    }
    if (consecutive < POLL_TIMEOUT_RESTART_AFTER) return
    if (Date.now() - this.#lastPollRestart < POLL_RESTART_COOLDOWN_MS) return
    this.#lastPollRestart = Date.now()
    this.#log.warn(`rebuilding the poller after ${consecutive} polls with no answer`)
    this.stopPolling({ restart: true })
    this.startPolling()
  }

  /**
   * Stop the poller.
   *
   * Two very different situations share this code: losing the slot (or
   * unloading), where everything in flight belongs to the next owner and must
   * be dropped; and a watchdog rebuild of a socket that stopped responding,
   * where this instance keeps owning the slot and discarding buffered answers
   * or pending questions would lose work for no reason.
   */
  stopPolling(options: { restart?: boolean } = {}): void {
    this.#stopMonitor?.()
    this.#stopMonitor = undefined
    this.#monitor = undefined
    if (options.restart) return

    // Hand any assembled-but-unsent turn to the persisted queue first: a hot
    // reload is routine, and losing a finished answer to one is invisible to
    // everyone (the agent believes it reported, the user sees nothing).
    this.#preserveTurnBuffers()
    for (const timer of this.#typingTimers.values()) clearInterval(timer)
    this.#typingTimers.clear()
    this.#typingSessions.clear()
    for (const timer of this.#retryTimers.values()) clearTimeout(timer)
    this.#retryTimers.clear()
    for (const turn of this.#turns.values()) if (turn.timer) clearTimeout(turn.timer)
    this.#turns.clear()
    for (const live of this.#live.values()) if (live.timer) clearInterval(live.timer)
    this.#live.clear()
  }

  /** Move every buffered turn into the persisted queue, so a stop cannot eat it. */
  #preserveTurnBuffers(): void {
    const sessions = new Set([...this.#turns.keys(), ...this.#live.keys()])
    for (const sessionID of sessions) {
      const live = this.#live.get(sessionID)
      const turn = this.#turns.get(sessionID)
      // Fragments already handed to the send path count as delivered, or a stop
      // that lands mid-send would queue the whole turn behind a fragment that is
      // about to arrive (the phone would get it twice).
      const streamed = (live?.sent ?? 0) + (live?.sending?.length ?? 0)
      // In live mode the delivered fragments are already on the phone, so only
      // the unsent tail is worth keeping — unless a fragment was dropped, in
      // which case the tail alone would be an orphan and the whole assembled
      // turn is the safer thing to send (it matches what `#finishTurn` does).
      const text =
        live && streamed > 0 && !live.degraded
          ? live.pending.trim()
          : (turn?.parts ?? []).join("\n\n").trim()
      const conversationId = turn?.conversationId ?? live?.conversationId
      if (!text || !conversationId) continue
      // Queue items are flushed without re-chunking and `sendText` refuses
      // anything over the service limit, so a long turn must be cut here — as a
      // single oversized item every retry would fail locally and the answer
      // would never arrive at all.
      const chunked = chunkText(renderForWechat(text), Math.max(64, this.#config.chunkSize - 12))
      this.#enqueue(conversationId, numberChunks(chunked))
      this.#log.info(`preserved an unfinished turn (${text.length} chars, ${chunked.length} part(s)) before stopping`)
    }
  }

  /**
   * The token was rejected: stop and say what to do about it.
   *
   * Only the token the *running* poller used may be cleared. A re-login can land
   * between the rejection and this call, and wiping the fresh credential would
   * cost the user another QR scan for a channel that was already fixed.
   */
  #handleStaleToken(rejectedToken?: string): void {
    if (!shouldClearStaleToken(this.#state.account?.token, rejectedToken)) {
      this.#log.info("a stale-token report arrived for an old credential; keeping the current one")
      return
    }
    this.#state = updateState((state) => {
      if (state.account) state.account = { ...state.account, token: "" }
    })
    this.#log.warn("微信 token 已失效，已停止轮询。重新登录：/wechat-login 或运行 login-cli.ts")
  }

  /*
   * -------------------------------------------------------------------------
   * Inbound
   * -------------------------------------------------------------------------
   */

  async handleInbound(message: InboundMessage): Promise<void> {
    const conversationId = conversationIdOf(message)
    this.#sweepStaleQuestions()

    // Duplicate suppression first: a duplicate costs a real model call, and
    // "same message twice" is indistinguishable from the user repeating
    // themselves once it reaches the session.
    if (message.messageId && this.#alreadyHandled(message.messageId)) {
      this.#log.info(`duplicate message ${message.messageId} ignored`)
      return
    }

    this.#state = updateState((state) => {
      if (message.contextToken) state.contextTokens[conversationId] = message.contextToken
      state.lastConversation = conversationId
      if (message.messageId) {
        state.seenMessages = [...(state.seenMessages ?? []), message.messageId].slice(-SEEN_MESSAGE_LIMIT)
      }
    })

    if (!this.#isAllowed(message.peerId)) {
      this.#log.warn(`ignored message from ${message.peerId}: not in allowedUsers`)
      return
    }

    // A fresh inbound message reopens the reply window: retry anything the
    // service refused while the conversation was quiet.
    if (this.#queueFor(conversationId).length > 0) {
      const timer = this.#retryTimers.get(conversationId)
      if (timer) {
        clearTimeout(timer)
        this.#retryTimers.delete(conversationId)
      }
      this.#setRetryAttempt(conversationId, 0)
      await this.#flushQueue(conversationId)
    }

    const attachments: { uri: string; name: string }[] = []
    const notes: string[] = []
    for (const item of message.media ?? []) {
      const result = await downloadItem({ account: this.#state.account!, item })
      if (result.media) {
        attachments.push({ uri: pathToFileURL(result.media.path).href, name: result.media.name })
        // Voice is the one kind the bridge cannot read: it arrives as .silk with
        // WeChat's transcript only when the user sent one, so say what it is
        // instead of handing the agent an opaque file.
        const kindHint = result.media.kind === "voice" ? "语音（桥不转写，需转写请自行处理）" : "附件"
        notes.push(
          `[收到${kindHint} ${result.media.name}（${result.media.bytes} 字节），已保存为本地文件：${result.media.path}]`,
        )
        // A size mismatch means the body may have been truncated in transit.
        if (result.note) notes.push(`[${result.note}]`)
      } else if (result.note) {
        notes.push(`[${result.note}]`)
      }
    }

    let text = [message.text, ...notes].filter(Boolean).join("\n\n").trim()
    if (text.length > MAX_INBOUND_CHARS) {
      text = `${text.slice(0, MAX_INBOUND_CHARS)}\n\n[消息过长，已截断]`
    }
    if (!text && attachments.length === 0) return

    // Titles must come from what the user wrote, never from the notes the bridge
    // adds — an image with no caption used to name its session after the
    // attachment notice.
    const titleHint = message.text?.trim() || this.#placeholderForMessage(message)

    this.#log.info(`inbound ${conversationId}: ${text.slice(0, 120).replace(/\n/g, " ")}`)

    // Commands first (the user is explicit), then a pending `wechat_ask`
    // question, and only then a bare approval shortcut: with an approval
    // pending, answering a question with "可以" used to approve a shell command
    // *and* leave the question blocking until timeout.
    if (looksLikeCommand(text) && (await this.#handleCommand(conversationId, text))) return

    // A question from `wechat_ask` consumes the next ordinary message: the agent
    // is blocked on it. Both sides of that exchange live in shared state, because
    // the instance running the tool is not necessarily the instance reading the
    // reply — and a plugin reload must not lose the question either.
    const pending = this.#state.pendingQuestions?.[conversationId]
    if (pending && pending.expiresAt > Date.now()) {
      this.#state = updateState((state) => {
        state.questionAnswers = {
          ...(state.questionAnswers ?? {}),
          [conversationId]: { text, answeredAt: Date.now() },
        }
      })
      this.#log.info(`question answered: ${text.slice(0, 80)}`)
      return
    }

    if (await this.#maybeHandlePermissionReply(conversationId, text)) return

    await this.#dispatch(conversationId, text, attachments, titleHint)
  }

  /** Drop question records whose asker is gone (reload/crash) or that expired. */
  #sweepStaleQuestions(): void {
    const now = Date.now()
    const ttl = 60 * 60_000
    const pending = Object.entries(this.#state.pendingQuestions ?? {}).filter(
      ([, entry]) => entry.expiresAt + ttl < now,
    )
    const answers = Object.entries(this.#state.questionAnswers ?? {}).filter(
      ([, entry]) => entry.answeredAt + ttl < now,
    )
    if (pending.length === 0 && answers.length === 0) return
    this.#state = updateState((state) => {
      const nextPending = { ...(state.pendingQuestions ?? {}) }
      const nextAnswers = { ...(state.questionAnswers ?? {}) }
      for (const [key] of pending) delete nextPending[key]
      for (const [key] of answers) delete nextAnswers[key]
      state.pendingQuestions = nextPending
      state.questionAnswers = nextAnswers
    })
  }

  /** Placeholder title for a message that carries no text at all. */
  #placeholderForMessage(message: InboundMessage): string | undefined {
    const kinds = new Set((message.media ?? []).map((item) => item.type))
    if (kinds.has(2)) return "图片"
    if (kinds.has(4)) return "文件"
    if (kinds.has(5)) return "视频"
    if (kinds.has(3)) return "语音"
    return undefined
  }

  /**
   * Ask the user a question in WeChat and wait for the reply.
   *
   * This is the "ask a human" escape hatch that needs nothing but the channel:
   * the agent stays blocked inside its tool call, the question arrives on the
   * phone, and the answer is the tool result. Times out rather than hanging
   * forever, because a session blocked on a question nobody answered is worse
   * than a session that was told to proceed.
   */
  async ask(conversationId: string, question: string, timeoutMs: number): Promise<string> {
    const existing = this.#state.pendingQuestions?.[conversationId]
    if (existing && existing.expiresAt > Date.now()) {
      return "已经有一个问题在等用户回答了，请先等它返回。"
    }

    const askedAt = Date.now()
    const expiresAt = askedAt + timeoutMs
    this.#state = updateState((state) => {
      state.lastConversation = conversationId
      state.pendingQuestions = {
        ...(state.pendingQuestions ?? {}),
        [conversationId]: { text: question.trim(), askedAt, expiresAt },
      }
    })

    const delivered = await this.#sendReturning(
      conversationId,
      [
        "❓ opencode 想问你：",
        question.trim(),
        "",
        `直接回复你的答案即可（${Math.round(timeoutMs / 60_000)} 分钟内有效）。`,
      ].join("\n"),
    )
    if (!delivered) {
      // "Not delivered" usually means the question was *queued* (the window is
      // shut) and will arrive with the next inbound — so keep it registered and
      // keep waiting, or the eventual reply would be dispatched as a stray
      // prompt instead of answering this call.
      this.#log.warn("question queued: the reply window is closed; still waiting for an answer")
    }

    return await this.#awaitAnswer(conversationId, askedAt, timeoutMs)
  }

  /**
   * Wait for the answer to a question, watching the shared state.
   *
   * The reply is written by whichever instance owns the poller, which may be a
   * different one; polling state is what makes the tool work in a multi-window
   * setup instead of timing out after ten minutes.
   */
  #awaitAnswer(conversationId: string, askedAt: number, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      const deadline = askedAt + timeoutMs
      const finish = (text: string): void => {
        clearInterval(timer)
        // Answer first: clearing is bookkeeping, and a state write that fails
        // must not swallow the answer this call is waiting for.
        resolve(text)
        try {
          this.#clearQuestion(conversationId, askedAt)
        } catch (error) {
          this.#log.warn(`clearing the question failed: ${errorText(error)}`)
        }
      }
      const timer = setInterval(() => {
        const answer = readState().questionAnswers?.[conversationId]
        if (answer && answer.answeredAt >= askedAt) {
          this.#log.info(`question answered: ${answer.text.slice(0, 80)}`)
          finish(answer.text)
          return
        }
        if (Date.now() > deadline) finish(`用户在 ${Math.round(timeoutMs / 60_000)} 分钟内没有回答。`)
      }, QUESTION_POLL_MS)
      timer.unref?.()
    })
  }

  /** Drop a settled question, and the answer that settled it. */
  #clearQuestion(conversationId: string, askedAt: number): void {
    this.#state = updateState((state) => {
      const pending = state.pendingQuestions?.[conversationId]
      if (pending && pending.askedAt === askedAt) {
        const next = { ...(state.pendingQuestions ?? {}) }
        delete next[conversationId]
        state.pendingQuestions = next
      }
      const answer = state.questionAnswers?.[conversationId]
      if (answer && answer.answeredAt >= askedAt) {
        const next = { ...(state.questionAnswers ?? {}) }
        delete next[conversationId]
        state.questionAnswers = next
      }
    })
  }

  /** Which conversation an agent tool should target. */
  get lastConversation(): string | undefined {
    return this.#state.lastConversation
  }

  /** Only the account's own user, plus anything the config explicitly allows. */
  #isAllowed(peerId: string): boolean {
    const allowed = this.#config.allowedUsers
    if (allowed.length === 0) {
      const account = this.#state.account
      // Logged out: nobody may drive the bot.
      if (!account?.token) return false
      if (!account.userId) {
        // The server can omit the bound user id (and older state files lack it).
        // Adopt the first sender instead of going deaf on every message.
        this.#state = updateState((state) => {
          if (state.account) state.account = { ...state.account, userId: peerId }
        })
        this.#log.warn(`账户没有记录绑定微信 id，已采用第一个发送者：${peerId}`)
        return true
      }
      return account.userId === peerId
    }
    if (allowed.includes(peerId)) return true
    return this.#state.account?.userId === peerId && allowed.includes("self")
  }

  async #dispatch(
    conversationId: string,
    text: string,
    attachments: { uri: string; name: string }[] = [],
    titleHint?: string,
  ): Promise<void> {
    let sessionID: string
    try {
      sessionID = await this.#ensureSession(conversationId, titleHint)
    } catch (error) {
      await this.#send(conversationId, `❌ 无法创建会话：${errorText(error)}`)
      return
    }

    const prompt = text || "（见附件）"
    try {
      await this.#ctx.session.prompt({
        sessionID,
        text: prompt,
        ...(attachments.length ? { files: attachments.map((item) => ({ uri: item.uri, name: item.name })) } : {}),
      })
    } catch (error) {
      await this.#send(conversationId, `❌ 发送失败：${errorText(error)}`)
      return
    }

    await this.#setTyping(conversationId, true)
    this.#typingSessions.set(sessionID, conversationId)
    if (this.#config.ack === "text") await this.#send(conversationId, "⏳ 收到，开始处理…")
    this.#startLive(sessionID, conversationId)
  }

  /*
   * -------------------------------------------------------------------------
   * Sessions
   * -------------------------------------------------------------------------
   */

  /** Resolve (or create) the session bound to this conversation. */
  async #ensureSession(conversationId: string, firstText?: string): Promise<string> {
    const binding = this.#state.bindings[conversationId]
    if (binding) {
      const existing = await this.#ctx.session.get({ sessionID: binding.sessionID }).catch(() => undefined)
      if (existing) {
        await this.#maybeAutoTitle(conversationId, binding, firstText)
        // Adopt whatever the phone has been using as its home channel, so an
        // existing install gains the channel semantics without a migration step.
        if (!this.#state.channelSessionID) {
          this.#state = updateState((state) => {
            state.channelSessionID = binding.sessionID
          })
        }
        return binding.sessionID
      }
      this.#log.warn(`bound session ${binding.sessionID} is gone`)
    }

    // A lent session that disappeared must not strand the conversation: fall
    // back to the phone's home channel before inventing yet another session.
    const channel = await this.#channelSession({ createIfMissing: binding === undefined })
    if (channel) {
      this.#bind(conversationId, { id: channel.id, title: channel.title, location: channel.location })
      if (binding) await this.#send(conversationId, `↩️ 之前那个会话没了，已回到主会话。`)
      return channel.id
    }

    return this.#createSession(conversationId, { firstText })
  }

  /**
   * The phone's home session.
   *
   * Created on first use with a stable title so it stays recognisable and always
   * lands at the top of the phone's list.
   */
  async #channelSession(options: { createIfMissing?: boolean } = {}): Promise<
    { id: string; title?: string; location?: { directory?: string } } | undefined
  > {
    const stored = this.#state.channelSessionID
    if (stored) {
      const existing = await this.#ctx.session.get({ sessionID: stored }).catch(() => undefined)
      if (existing) return existing as unknown as { id: string; title?: string; location?: { directory?: string } }
      this.#log.warn(`channel session ${stored} is gone; a new one will be created`)
      this.#state = updateState((state) => {
        state.channelSessionID = undefined
      })
    }

    if (!options.createIfMissing) return undefined

    const directory = this.#defaultDirectory()
    const created = await this.#createThroughContext(directory, "主会话")
    this.#state = updateState((state) => {
      state.channelSessionID = created.id
      state.phoneSessions = [created.id, ...(state.phoneSessions ?? []).filter((id) => id !== created.id)].slice(0, 50)
    })
    this.#log.info(`channel session created: ${created.id}`)
    return { id: created.id, title: "主会话", location: { directory } }
  }

  /** Create a session, bind it to the conversation and return its id. */
  async #createSession(
    conversationId: string,
    options: { directory?: string; title?: string; firstText?: string },
  ): Promise<string> {
    const directory = options.directory ?? this.#defaultDirectory()
    const title = options.title ?? titleFromText(options.firstText ?? "") ?? "微信"

    const created = await this.#createThroughContext(directory, title)
    const sessionID = (created as { id: string }).id
    this.#state = updateState((state) => {
      state.bindings[conversationId] = { sessionID, directory, title, boundAt: Date.now() }
    })
    this.#rememberPhoneSession(sessionID)
    this.#log.info(`session ${sessionID} created at ${directory} for ${conversationId}${options.title ? "" : " (auto title)"}`)
    return sessionID
  }

  /**
   * Create a session, pinning agent and model.
   *
   * A session created with neither is a session the desktop lists oddly (no
   * agent, no model to show) and the TUI cannot resume with a model picker, so
   * the defaults are resolved explicitly instead of being left undefined.
   */
  async #createThroughContext(directory: string, title: string): Promise<{ id: string }> {
    const agent = this.#config.agent || undefined
    const model = this.#parseModelRef(this.#config.model)

    let resolvedModel = model
    if (!resolvedModel) {
      const fallback = unwrapData<{ providerID: string; modelID: string }>(
        await this.#ctx.model.default().catch(() => undefined),
      )
      if (fallback?.providerID && fallback?.modelID) {
        resolvedModel = { providerID: fallback.providerID, id: fallback.modelID }
      }
    }

    return (await this.#ctx.session.create({
      title,
      location: { directory },
      // Mark the origin so a session created from the phone is recognisable on
      // the desktop; the bridge's own bookkeeping stays in its state file.
      metadata: { wechat: { origin: "phone" } },
      ...(agent ? { agent } : {}),
      ...(resolvedModel ? { model: resolvedModel } : {}),
    })) as { id: string }
  }

  /** Remember that a session belongs on the phone's list. */
  #rememberPhoneSession(sessionID: string): void {
    this.#state = updateState((state) => {
      const known = state.phoneSessions ?? []
      state.phoneSessions = [sessionID, ...known.filter((id) => id !== sessionID)].slice(0, 50)
    })
  }

  #parseModelRef(value: string): { providerID: string; id: string } | undefined {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const [providerID, ...rest] = trimmed.split("/")
    const id = rest.join("/")
    if (!providerID || !id) return undefined
    return { providerID, id }
  }

  /** Titles the bridge made up, and may therefore replace with real text. */
  static readonly PLACEHOLDER_TITLES = new Set(["微信", "图片", "文件", "视频", "语音"])

  /** Rename a freshly created "微信" session after the first real instruction. */
  async #maybeAutoTitle(conversationId: string, binding: SessionBinding, firstText?: string): Promise<void> {
    if (!this.#config.autoTitle || !firstText) return
    const current = binding.title?.trim()
    if (current && !Bridge.PLACEHOLDER_TITLES.has(current)) return
    const title = titleFromText(firstText)
    if (!title || Bridge.PLACEHOLDER_TITLES.has(title)) return
    try {
      await this.#ctx.session.update({ sessionID: binding.sessionID, title })
      this.#state = updateState((state) => {
        const current = state.bindings[conversationId]
        if (current) state.bindings[conversationId] = { ...current, title }
      })
    } catch (error) {
      this.#log.warn(`auto title failed: ${errorText(error)}`)
    }
  }

  #defaultDirectory(): string {
    const configured = this.#state.defaultDirectory ?? this.#config.directory
    return isAbsolute(configured) ? configured : resolvePath(configured)
  }

  /**
   * Interpret a user-typed path (`/new`, `/dir`).
   *
   * Quotes are stripped because Windows users paste `"D:\code\repo"`, `~`
   * expands to the home directory, and a relative path resolves against the
   * *current session's* directory — resolving it against the plugin process's
   * cwd was silently unpredictable from the phone. The caller always echoes the
   * resolved path back.
   */
  #resolveUserPath(argument: string, conversationId: string): string {
    const unquoted = stripQuotes(argument)
    if (unquoted === "~") return resolvePath(homedir())
    if (unquoted.startsWith("~") && /^[\\/]/.test(unquoted.slice(1))) {
      return resolvePath(join(homedir(), unquoted.slice(2)))
    }
    if (isAbsolute(unquoted)) return resolvePath(unquoted)
    const base = this.#state.bindings[conversationId]?.directory ?? this.#defaultDirectory()
    return resolvePath(join(base, unquoted))
  }

  #alreadyHandled(messageId: string): boolean {
    return (this.#state.seenMessages ?? []).includes(messageId)
  }

  bindingFor(conversationId: string): SessionBinding | undefined {
    return this.#state.bindings[conversationId]
  }

  /*
   * -------------------------------------------------------------------------
   * Commands
   * -------------------------------------------------------------------------
   */

  /** @returns true when the text was a command and has been handled. */
  async #handleCommand(conversationId: string, text: string): Promise<boolean> {
    // The command word is NFKC-normalised: Chinese IMEs emit full-width input
    // (`／列表`, `／attach ２`) and a command that silently does nothing is worse
    // than one that explains itself. Arguments stay untouched so a path or title
    // keeps whatever the user typed.
    const [rawCommand, ...rest] = text.split(/\s+/)
    const command = (rawCommand ?? "").normalize("NFKC").toLowerCase().replace(/[:：]$/, "")
    const argument = rest.join(" ").trim()

    switch (command) {
      case "/help":
      case "/?":
      case "/帮助":
      case "/手册":
        await this.#help(conversationId, argument)
        return true

      case "/new":
      case "/新":
        await this.#newSession(conversationId, argument)
        return true

      case "/list":
      case "/列表":
        await this.#listSessions(conversationId, argument)
        return true

      case "/switch":
      case "/切换":
        await this.#switchSession(conversationId, argument)
        return true

      case "/attach":
      case "/follow":
      case "/跟随":
        await this.#attachSession(conversationId, argument)
        return true

      case "/detach":
      case "/断开":
      case "/释放":
        await this.#detachSession(conversationId)
        return true

      case "/channel":
      case "/通道":
        await this.#handleChannel(conversationId, argument)
        return true

      case "/last":
      case "/back":
      case "/切回":
        await this.#switchBack(conversationId)
        return true

      case "/queue":
      case "/队列":
        await this.#handleQueue(conversationId, argument)
        return true

      case "/current":
      case "/当前":
        await this.#send(conversationId, await this.#describeCurrent(conversationId))
        return true

      case "/rename":
      case "/重命名":
        await this.#renameSession(conversationId, argument)
        return true

      case "/cancel":
      case "/stop":
      case "/停":
        await this.#cancel(conversationId, argument)
        return true

      case "/model":
      case "/模型":
        await this.#handleModel(conversationId, argument)
        return true

      case "/agent":
        await this.#handleAgent(conversationId, argument)
        return true

      case "/cost":
      case "/花费":
        await this.#send(conversationId, await this.#describeCost(conversationId))
        return true

      case "/dir":
      case "/目录":
        await this.#handleDirectory(conversationId, argument)
        return true

      case "/status":
      case "/状态":
        await this.#send(conversationId, await this.describeStatus())
        return true

      case "/retry":
        await this.#retryQueued(conversationId)
        return true

      case "/more":
      case "/继续":
      case "/接着":
        await this.#more(conversationId)
        return true

      case "/allow":
      case "/允许":
        await this.#resolveQueuedPermission(conversationId, argument, "once")
        return true

      case "/always":
        await this.#resolveQueuedPermission(conversationId, argument, "always")
        return true

      case "/deny":
      case "/拒绝":
        await this.#resolveQueuedPermission(conversationId, argument, "reject")
        return true

      case "/answer":
      case "/答":
        await this.#answerForm(conversationId, argument)
        return true

      case "/log":
      case "/日志":
        await this.#send(conversationId, this.#logTail(Number.parseInt(argument, 10) || LOG_TAIL_LINES))
        return true

      case "/ping":
        await this.#send(conversationId, `🏓 pong（${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`)
        return true

      case "/whoami":
        await this.#send(
          conversationId,
          [`👤 ${conversationId}`, `白名单：${this.#config.allowedUsers.join(", ") || "未设置（仅绑定用户）"}`].join("\n"),
        )
        return true

      default:
        return false
    }
  }

  async #newSession(conversationId: string, argument: string): Promise<void> {
    let directory: string | undefined
    let title: string | undefined

    if (argument) {
      const candidate = this.#resolveUserPath(argument, conversationId)
      const stats = await fs.stat(candidate).catch(() => undefined)
      if (stats?.isDirectory()) {
        directory = candidate
        title = basename(candidate)
      } else {
        title = stripQuotes(argument)
      }
    }

    try {
      const sessionID = await this.#createSession(conversationId, { directory, title })
      const effectiveDirectory = directory ?? this.#defaultDirectory()
      await this.#send(
        conversationId,
        [`✅ 新会话已就绪`, `标题：${title ?? "微信"}`, `目录：${effectiveDirectory}`, `编号：${sessionID}`, "", "直接发消息即可。"].join(
          "\n",
        ),
      )
    } catch (error) {
      await this.#send(conversationId, `❌ 创建失败：${errorText(error)}`)
    }
  }

  /** Session list from the API when available, otherwise the bridge's own bindings. */
  async #collectSessions(): Promise<{ sessions: ApiSession[]; total: number; source: "api" | "bindings" }> {
    if (this.#api.available) {
      // Ask for more than one page: the lists page through everything, and the
      // desktop can hold a few hundred sessions.
      const sessions = await this.#api.listSessions({ limit: Math.max(this.#config.listLimit * 4, 200) })
      if (sessions.length > 0) return { sessions, total: sessions.length, source: "api" }
    }
    const sessions: ApiSession[] = Object.entries(this.#state.bindings)
      .sort((a, b) => b[1].boundAt - a[1].boundAt)
      .map(([, binding]) => ({
        id: binding.sessionID,
        title: binding.title,
        location: { directory: binding.directory },
        time: { created: binding.boundAt, updated: binding.boundAt },
      }))
    return { sessions, total: sessions.length, source: "bindings" }
  }

  async #listSessions(conversationId: string, argument: string): Promise<void> {
    const { sessions, source } = await this.#collectSessions()
    const current = this.#state.bindings[conversationId]?.sessionID
    const channelID = this.#state.channelSessionID
    const phoneIDs = new Set(this.#state.phoneSessions ?? [])
    if (current) phoneIDs.add(current)
    if (channelID) phoneIDs.add(channelID)

    // "/list [页码]" pages the phone's own list; "/list all [页码]" everything
    // else. Indices are global (page 2 starts at 16), so `/attach 42` works no
    // matter which page the number came from.
    const raw = normalizeArgument(argument)
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean)
    const wantOthers = tokens.includes("all")
    const numericTokens = tokens.filter((token) => token !== "all")
    // Two page numbers ("/list 2 all 3") are ambiguous, and junk is junk: say so
    // rather than silently picking one.
    const invalid = numericTokens.find((token) => !/^\d+$/.test(token))
    if (numericTokens.length > 1 || invalid !== undefined) {
      await this.#send(
        conversationId,
        invalid !== undefined
          ? `用法：/list [all] [页码] —— 看不懂「${invalid}」`
          : `页码只能给一个：/list [all] [页码]`,
      )
      return
    }
    const pageToken = numericTokens[0]
    const requested = pageToken === undefined ? 1 : Number.parseInt(pageToken, 10)
    const page = requested > 0 ? requested : 1
    const channel = channelID ? sessions.find((session) => session.id === channelID) : undefined

    if (wantOthers) {
      // Everything the phone does not own: terminal sessions, older work, and
      // anything the user has not lent to the phone yet.
      const others = sessions.filter((session) => !phoneIDs.has(session.id))
      this.#lastListing.set(
        conversationId,
        others.map((session) => session.id),
      )
      if (others.length === 0) {
        await this.#send(conversationId, "没有其他会话。")
        return
      }
      const pageSize = this.#config.listLimit * 2
      const pages = Math.max(1, Math.ceil(others.length / pageSize))
      const shownPage = Math.min(page, pages)
      const start = (shownPage - 1) * pageSize
      const shown = others.slice(start, start + pageSize)
      await this.#send(
        conversationId,
        [
          `🖥 其他会话（共 ${others.length} 个${pages > 1 ? `，第 ${shownPage}/${pages} 页` : ""}）：`,
          ...shown.map((session, index) => {
            const bits = [shortDirectory(session.location?.directory), session.agent ?? undefined].filter(Boolean)
            return `  ${start + index + 1}. ${session.title ?? "(无标题)"}\n     ${bits.join(" · ")}`
          }),
          "",
          "用 /attach 序号 把它接到手机。",
          pages > 1 ? `翻页：/list all ${shownPage < pages ? shownPage + 1 : 1}` : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      )
      return
    }

    // The phone's own list: the channel first, then everything the phone owns,
    // newest first, so it never has to be searched for among terminal sessions.
    const phoneSessions = sessions.filter((session) => phoneIDs.has(session.id) && session.id !== channelID)
    const ordered = channel ? [channel, ...phoneSessions] : phoneSessions
    this.#lastListing.set(
      conversationId,
      ordered.map((session) => session.id),
    )

    if (ordered.length === 0) {
      await this.#send(conversationId, "还没有手机会话。发一条消息就会创建主会话。")
      return
    }

    const pageSize = Math.max(this.#config.listLimit, 1)
    const pages = Math.max(1, Math.ceil(ordered.length / pageSize))
    const shownPage = Math.min(page, pages)
    const start = (shownPage - 1) * pageSize
    const shown = ordered.slice(start, start + pageSize)
    const lines: string[] = []
    for (const [index, session] of shown.entries()) {
      const marker = session.id === current ? "▶" : " "
      const pinned = session.id === channelID ? "📌" : "  "
      const bits = [shortDirectory(session.location?.directory), session.agent ?? undefined].filter(Boolean)
      lines.push(`${marker}${pinned}${start + index + 1}. ${session.title ?? "(无标题)"}\n        ${bits.join(" · ")}`)
    }
    await this.#send(
      conversationId,
      [
        `📱 手机会话（共 ${ordered.length} 个${pages > 1 ? `，第 ${shownPage}/${pages} 页` : ""}）：`,
        ...lines,
        "",
        channelID ? `📌 主会话：${channel?.title ?? "（未命名）"}（/detach 回到它）` : "",
        "用 /attach 序号 接管某个会话；其他会话见 /list all。",
        pages > 1 ? `翻页：/list ${shownPage < pages ? shownPage + 1 : 1}` : "",
        source === "api" ? "" : "（本地 API 不可用，仅列出微信建过的会话）",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    )
  }

  /** Resolve a list index against what was last shown, then the full list. */
  async #resolveIndexed(argument: string): Promise<ApiSession | undefined> {
    // NFKC first: `Number.parseInt("３")` is NaN, so a full-width index used to
    // fall through to a lookup that could not match either.
    const value = normalizeArgument(argument)
    const { sessions } = await this.#collectSessions()
    const conversationId = this.#state.lastConversation ?? ""
    const remembered = this.#lastListing.get(conversationId)
    const index = Number.parseInt(value, 10)
    if (Number.isFinite(index) && String(index) === value && remembered) {
      const id = remembered[index - 1]
      const found = id ? sessions.find((session) => session.id === id) : undefined
      if (found) return found
    }
    return resolveSessionTarget(sessions, value)
  }

  async #switchSession(conversationId: string, argument: string): Promise<void> {
    if (!argument) {
      await this.#send(conversationId, "用法：/switch 序号 或 /switch 短号（先 /list 看列表）")
      return
    }

    let target = await this.#resolveIndexed(argument)

    if (!target) {
      // Fall back to a direct id lookup: the user may paste an id from the desktop.
      const byId = await this.#ctx.session.get({ sessionID: argument }).catch(() => undefined)
      if (byId) {
        const info = byId as { id: string; title?: string; location?: { directory?: string } }
        target = {
          id: info.id,
          title: info.title,
          location: info.location,
          time: { updated: Date.now() },
        }
      }
    }

    if (!target) {
      await this.#send(conversationId, `没找到匹配的会话：${argument}`)
      return
    }

    this.#bind(conversationId, target, { explicit: true })
    await this.#send(conversationId, `✅ 已切换到 ${target.title ?? "未命名"}\n目录：${shortDirectory(target.location?.directory)}`)
  }

  /** Swap back to the session this conversation had before the last switch. */
  async #switchBack(conversationId: string): Promise<void> {
    const binding = this.#state.bindings[conversationId]
    const previous = binding?.previousSessionID
    if (!previous) {
      await this.#send(conversationId, "还没有切换记录。用 /list 看会话。")
      return
    }
    const target = await this.#ctx.session.get({ sessionID: previous }).catch(() => undefined)
    if (!target) {
      this.#state = updateState((state) => {
        const current = state.bindings[conversationId]
        if (current) state.bindings[conversationId] = { ...current, previousSessionID: undefined }
      })
      await this.#send(conversationId, "上一个会话已经不在了。")
      return
    }
    const info = target as unknown as { id: string; title?: string; location?: { directory?: string } }
    this.#bind(conversationId, info, { explicit: true })
    await this.#send(conversationId, `↩️ 已切回 ${info.title ?? info.id.slice(-8)}`)
  }

  /**
   * Pick the session the desktop is most likely working in.
   *
   * "Running" beats "recently updated": a session with a turn in flight is the
   * strongest signal the API offers, and the API does not report which window is
   * focused. With `runningOnly` there is no fallback at all — auto-follow must
   * never jump to a session merely because it was touched recently, or a busy
   * background session would silently capture the conversation.
   */
  async #pickActiveSession(options: { exclude?: string; runningOnly?: boolean } = {}): Promise<ApiSession | undefined> {
    if (!this.#api.available) return undefined
    const [active, sessions] = await Promise.all([
      this.#api.listActiveSessions(),
      this.#api.listSessions({ limit: Math.max(this.#config.listLimit * 3, 60) }),
    ])
    const candidates = sessions.filter((session) => session.id !== options.exclude && !session.parentID)
    const running = candidates.find((session) => active.includes(session.id))
    if (running) return running
    return options.runningOnly ? undefined : candidates[0]
  }

  /** Record a binding, remembering the previous one and whether it was explicit. */
  #bind(
    conversationId: string,
    target: { id: string; title?: string; location?: { directory?: string } },
    options: { explicit?: boolean } = {},
  ): void {
    this.#state = updateState((state) => {
      const previous = state.bindings[conversationId]
      state.bindings[conversationId] = {
        sessionID: target.id,
        directory: target.location?.directory ?? this.#defaultDirectory(),
        title: target.title,
        boundAt: Date.now(),
        ...(previous && previous.sessionID !== target.id ? { previousSessionID: previous.sessionID } : {}),
        ...(options.explicit ? { switchedAt: Date.now() } : {}),
      }
    })
  }

  /**
   * Bind this conversation to the session the desktop is working in.
   *
   * With no argument the bridge picks the busiest session; with one it behaves
   * like `/switch`, except that the choice is remembered so auto-follow leaves
   * it alone for a while.
   */
  async #attachSession(conversationId: string, argument: string): Promise<void> {
    if (argument) {
      let target = await this.#resolveIndexed(argument)
      if (!target) {
        // A pasted id may be older than the fetched list (or the local API may be
        // down); `/switch` already accepts that, so `/attach` must too — the two
        // are documented as the same operation with different bookkeeping.
        const byId = (await this.#ctx.session.get({ sessionID: argument.trim() }).catch(() => undefined)) as
          | { id: string; title?: string; location?: { directory?: string } }
          | undefined
        if (byId) {
          target = { id: byId.id, title: byId.title, location: byId.location, time: { updated: Date.now() } }
        }
      }
      if (!target) {
        await this.#send(conversationId, `没找到匹配的会话：${argument}`)
        return
      }
      // Same path as the desktop button, so both surfaces record the same thing
      // (phone list, 📱 marker, follow hold).
      const result = await this.lendSession(target.id)
      if (!result.ok) await this.#send(conversationId, `没接上：${result.message ?? "未知原因"}`)
      return
    }

    const target = await this.#pickActiveSession()
    if (!target) {
      await this.#send(conversationId, "本地 API 不可用或没有会话可跟随。用 /list 手动挑一个。")
      return
    }

    // Same bookkeeping as `lendSession` (phone list, 📱 marker, explicit hold):
    // without it the borrowed session was missing from /list and never got the
    // marker, because only the argument path called lendSession.
    const running = (await this.#api.listActiveSessions()).includes(target.id)
    this.#bind(conversationId, target, { explicit: true })
    this.#rememberPhoneSession(target.id)
    await this.#markPhoneUsage(target.id, true)
    await this.#send(
      conversationId,
      [
        "📎 已跟随到电脑上的会话",
        `标题：${target.title ?? "(无标题)"}`,
        `目录：${target.location?.directory ?? "?"}`,
        `状态：${running ? "正在运行" : "空闲"}`,
        `编号：${target.id}`,
        "",
        "之后这里就是这条会话了；电脑上给它发消息，回答也会到微信。",
      ].join("\n"),
    )
  }

  /**
   * Keep the conversation on the session the desktop is using.
   *
   * Deliberately conservative: only follows sessions touched within the follow
   * window, never overrides a recent explicit `/switch`, and always says when it
   * moved — a channel that silently changes which conversation you are talking
   * to would be worse than no follow at all.
   */
  async followActiveSession(): Promise<void> {
    if (!this.#config.followActive || !this.#api.available) return
    const conversationId = this.#state.lastConversation
    if (!conversationId) return

    const binding = this.#state.bindings[conversationId]
    if (!binding) return

    const now = Date.now()
    if (binding.switchedAt && now - binding.switchedAt < this.#config.followHoldMs) return
    if ((this.#followed.get(conversationId) ?? 0) > now - this.#config.followHoldMs) return

    // Never move the phone while an answer is in flight or something waits on it.
    // Re-binding makes the old session's events unresolvable, so its
    // `session.text.ended` was dropped (the answer never arrived) and its
    // approval never reached the phone at all.
    const current = binding.sessionID
    if (
      this.#turns.has(current) ||
      this.#live.has(current) ||
      this.#typingSessions.has(current) ||
      this.#pendingPermissions.some((item) => item.conversationId === conversationId) ||
      this.#pendingForms.some((item) => item.conversationId === conversationId)
    ) {
      return
    }
    if (this.#state.pendingQuestions?.[conversationId]) return

    const candidate = await this.#pickActiveSession({ exclude: binding.sessionID, runningOnly: true })
    if (!candidate) return

    // Only follow work that is actually happening now.
    const updated = candidate.time?.updated ?? candidate.time?.created ?? 0
    if (updated && now - updated > this.#config.followWindowMs) return

    this.#bind(conversationId, candidate)
    this.#followed.set(conversationId, now)
    this.#log.info(`auto-followed session ${candidate.id}`)
    await this.#send(
      conversationId,
      `🔀 已跟随到电脑上正在用的会话：${candidate.title ?? candidate.id.slice(-8)}\n（想固定住就 /attach 或 /switch，5 分钟内不会再跟着跳）`,
    )
  }

  /** `/detach`: hand the borrowed session back and return to the channel. */
  async #detachSession(conversationId: string): Promise<void> {
    const channel = await this.#channelSession({ createIfMissing: true })
    if (!channel) {
      await this.#send(conversationId, "无法创建主会话。")
      return
    }
    const binding = this.#state.bindings[conversationId]
    if (binding?.sessionID === channel.id) {
      await this.#send(conversationId, `已经在主会话上了：${channel.title ?? "主会话"}`)
      return
    }
    // Leaving a session also clears its phone marker — and it counts as a manual
    // move, so auto-follow does not re-attach within the hold window (otherwise
    // /detach looked broken: the next 10 s tick put the phone straight back).
    if (binding?.sessionID) await this.#markPhoneUsage(binding.sessionID, false)
    this.#bind(conversationId, { id: channel.id, title: channel.title, location: channel.location })
    this.#state = updateState((state) => {
      const current = state.bindings[conversationId]
      if (current) state.bindings[conversationId] = { ...current, switchedAt: Date.now() }
    })
    this.#rememberPhoneSession(channel.id)
    await this.#send(
      conversationId,
      `↩️ 已切回主会话${binding?.title ? `（离开了「${binding.title}」，它之后的消息不会再打扰你）` : ""}`,
    )
  }

  /** Mark a session as "the phone is using it" in a way every client shows. */
  async #markPhoneUsage(sessionID: string, on: boolean): Promise<void> {
    const PREFIX = "📱 "
    const session = (await this.#ctx.session.get({ sessionID }).catch(() => undefined)) as { title?: string } | undefined
    const title = session?.title ?? ""
    if (!title) return
    const hasPrefix = title.startsWith(PREFIX)
    if (on === hasPrefix) return
    const next = on ? `${PREFIX}${title}` : title.slice(PREFIX.length)
    await this.#ctx.session.update({ sessionID, title: next }).catch(() => {})
    this.#state = updateState((state) => {
      for (const [key, binding] of Object.entries(state.bindings)) {
        if (binding.sessionID === sessionID) state.bindings[key] = { ...binding, title: next }
      }
    })
  }

  /**
   * Hand a session to the phone.
   *
   * The desktop button and `/attach` both land here: one place decides what
   * "the phone is talking to this session" means, so the two surfaces cannot
   * disagree.
   */
  async lendSession(sessionID: string): Promise<{ ok: boolean; title?: string; message?: string; label: string }> {
    const conversationId = this.#state.lastConversation
    if (!conversationId) return { ok: false, label: "还没有微信对话", message: "先让用户在微信里发一条消息" }

    const session = await this.#ctx.session.get({ sessionID }).catch(() => undefined)
    if (!session) return { ok: false, label: "会话不存在" }
    const info = session as unknown as { id: string; title?: string; location?: { directory?: string } }

    this.#bind(conversationId, info, { explicit: true })
    this.#rememberPhoneSession(sessionID)
    // A marker in the session title is the one indicator every client shows.
    await this.#markPhoneUsage(sessionID, true)
    await this.#send(
      conversationId,
      `📱 已把这个会话接到微信：${info.title ?? sessionID.slice(-8)}\n（现在手机发消息会进这里；发 /detach 就切回主会话）`,
    )
    return { ok: true, title: info.title, label: `已接到微信：${info.title ?? sessionID.slice(-8)}` }
  }

  /** Give the session back: the phone returns to its home channel. */
  async releaseSession(): Promise<{ ok: boolean; title?: string; message?: string; label: string }> {
    const conversationId = this.#state.lastConversation
    if (!conversationId) return { ok: false, label: "还没有微信对话", message: "先让用户在微信里发一条消息" }

    const channel = await this.#channelSession({ createIfMissing: true })
    if (!channel) return { ok: false, label: "无法创建主会话" }

    const leaving = this.#state.bindings[conversationId]?.sessionID
    if (leaving && leaving !== channel.id) await this.#markPhoneUsage(leaving, false)
    this.#bind(conversationId, { id: channel.id, title: channel.title, location: channel.location })
    this.#rememberPhoneSession(channel.id)
    await this.#send(conversationId, "↩️ 已切回主会话。")
    return { ok: true, title: channel.title, label: "已切回主会话" }
  }

  /** `/help` — the overview, one command's card, or the full manual. */
  async #help(conversationId: string, argument: string): Promise<void> {
    const wanted = argument.trim()
    if (!wanted) {
      await this.#send(conversationId, HELP_TEXT)
      return
    }
    if (/^(all|全部|手册|manual)$/i.test(wanted)) {
      await this.#send(conversationId, renderManual())
      return
    }
    const doc = resolveCommandDoc(wanted)
    if (!doc) {
      await this.#send(conversationId, `没有这条命令：${wanted}\n发 /help 看总览，/help 全部 看完整手册。`)
      return
    }
    await this.#send(conversationId, renderCommandDoc(doc))
  }

  /** Show or pin the phone's home session. */
  async #handleChannel(conversationId: string, argument: string): Promise<void> {
    if (argument) {
      // A number comes from the last list shown (like `/attach`); an id or a
      // title is accepted as well.
      let target = await this.#resolveIndexed(argument)
      if (!target) {
        const byId = await this.#ctx.session.get({ sessionID: argument }).catch(() => undefined)
        if (byId) target = byId as unknown as ApiSession
      }
      if (!target) {
        await this.#send(conversationId, `没找到会话：${argument}`)
        return
      }
      const info = target as unknown as { id: string; title?: string; location?: { directory?: string } }
      this.#state = updateState((state) => {
        state.channelSessionID = info.id
      })
      this.#rememberPhoneSession(info.id)
      await this.#send(conversationId, `📌 已把「${info.title ?? info.id.slice(-8)}」设为主会话（/detach 回到它）。`)
      return
    }

    const channel = await this.#channelSession({ createIfMissing: true })
    const binding = this.#state.bindings[conversationId]
    if (!channel) {
      await this.#send(conversationId, "还没有主会话。")
      return
    }
    await this.#send(
      conversationId,
      [
        `📌 主会话：${channel.title ?? "主会话"}`,
        `编号：${channel.id}`,
        `当前对话在：${binding?.title ?? binding?.sessionID?.slice(-8) ?? "（未绑定）"}`,
        "",
        "发 /detach 可以随时切回通道；发 /channel <会话id> 可以换一个通道。",
      ].join("\n"),
    )
  }

  /** Show or clear whatever is waiting to be sent to this conversation. */
  async #handleQueue(conversationId: string, argument: string): Promise<void> {
    const queued = this.#queueFor(conversationId)
    const head = normalizeArgument(argument).toLowerCase().split(/\s+/)[0]
    if (head === "clear") {
      const dropped = this.#dropQueue(conversationId)
      await this.#send(conversationId, dropped > 0 ? `🗑 已丢弃 ${dropped} 条待发消息。` : "没有待发消息。")
      return
    }
    if (queued.length === 0) {
      await this.#send(conversationId, "没有待发消息。")
      return
    }
    await this.#send(
      conversationId,
      [
        `📮 有 ${queued.length} 条等你说话后补发：`,
        ...queued.slice(0, 5).map((item, index) => `${index + 1}. ${item.text.replace(/\s+/g, " ").slice(0, 80)}`),
        "",
        "用 /more 立刻补发（/retry 同效），/queue clear 丢弃。",
      ].join("\n"),
    )
  }

  async #describeCurrent(conversationId: string): Promise<string> {
    const binding = this.#state.bindings[conversationId]
    if (!binding) return "当前还没有绑定会话。发一条消息就会自动建一个。"

    const remote = this.#api.available ? await this.#api.getSession(binding.sessionID) : undefined
    if (remote) return describeSession(remote, binding.directory)
    return describeSession(
      { id: binding.sessionID, title: binding.title, location: { directory: binding.directory } },
      binding.directory,
    )
  }

  async #renameSession(conversationId: string, argument: string): Promise<void> {
    const binding = this.#state.bindings[conversationId]
    if (!binding) {
      await this.#send(conversationId, "当前没有会话。")
      return
    }
    if (!argument) {
      await this.#send(conversationId, `当前标题：${binding.title ?? "(无)"}\n用法：/rename 新标题`)
      return
    }
    try {
      // A *lent* session (one carrying the 📱 marker) keeps it: renaming used to
      // strip it, and the desktop then could not tell the phone was still using
      // the session. A session the phone created itself gets no marker.
      const existing = (await this.#ctx.session.get({ sessionID: binding.sessionID }).catch(() => undefined)) as
        | { title?: string }
        | undefined
      const wasMarked = (existing?.title ?? binding.title ?? "").startsWith("📱 ")
      const title = wasMarked && !argument.startsWith("📱 ") ? `📱 ${argument}` : argument
      await this.#ctx.session.update({ sessionID: binding.sessionID, title })
      this.#state = updateState((state) => {
        const current = state.bindings[conversationId]
        if (current) state.bindings[conversationId] = { ...current, title }
      })
      await this.#send(conversationId, `✅ 已重命名为「${title}」`)
    } catch (error) {
      await this.#send(conversationId, `❌ 重命名失败：${errorText(error)}`)
    }
  }

  async #cancel(conversationId: string, argument: string): Promise<void> {
    const wantsQueueDrop = normalizeArgument(argument).toLowerCase().split(/\s+/).includes("all")
    const binding = this.#state.bindings[conversationId]
    if (!binding) {
      await this.#send(conversationId, "当前没有会话。")
      return
    }
    try {
      await this.#ctx.session.interrupt({ sessionID: binding.sessionID })
      // An interrupted turn may never report idle, and the typing indicator and
      // live buffer are only stopped by that report: stop them here instead of
      // leaving "typing…" on the phone indefinitely.
      await this.#setTyping(conversationId, false)
      this.#typingSessions.delete(binding.sessionID)
      // Drop both buffers: the live buffer is the only record that a prefix was
      // already streamed, so leaving the turn behind would resend the whole
      // answer when the grace timer fires.
      const live = this.#live.get(binding.sessionID)
      if (live?.timer) clearInterval(live.timer)
      this.#live.delete(binding.sessionID)
      const turn = this.#turns.get(binding.sessionID)
      if (turn?.timer) clearTimeout(turn.timer)
      this.#turns.delete(binding.sessionID)
      const dropped = wantsQueueDrop ? this.#dropQueue(conversationId) : 0
      await this.#send(
        conversationId,
        dropped > 0 ? `⏹ 已请求中断，并丢弃了 ${dropped} 条待发消息。` : "⏹ 已请求中断当前任务。",
      )
    } catch (error) {
      await this.#send(conversationId, `❌ 中断失败：${errorText(error)}`)
    }
  }

  async #handleModel(conversationId: string, argument: string): Promise<void> {
    const binding = this.#state.bindings[conversationId]
    if (!binding) {
      await this.#send(conversationId, "当前没有会话。先发一条消息或 /new。")
      return
    }

    const models = await this.#collectModels()
    if (!argument) {
      const current = this.#state.bindings[conversationId]?.model
      await this.#send(conversationId, formatModelList(models, current))
      return
    }

    const target = resolveModelTarget(models, argument)
    if (!target) {
      await this.#send(conversationId, `没找到模型：${argument}（先发 /model 看列表）`)
      return
    }

    try {
      await this.#ctx.session.switchModel({ sessionID: binding.sessionID, model: { providerID: target.providerID, id: target.id } })
      this.#state = updateState((state) => {
        const current = state.bindings[conversationId]
        if (current) state.bindings[conversationId] = { ...current, model: { providerID: target.providerID, id: target.id } }
      })
      await this.#send(conversationId, `✅ 已切换模型：${target.providerID}/${target.id}`)
    } catch (error) {
      await this.#send(conversationId, `❌ 切换失败：${errorText(error)}`)
    }
  }

  async #collectModels(): Promise<ModelSummary[]> {
    try {
      const raw = await this.#ctx.model.list()
      const models = unwrapList<{
        id: string
        providerID: string
        name?: string
        cost?: Array<{ input: number }>
        limit?: { context?: number }
        enabled?: boolean
      }>(raw)
      return models.map((model) => ({
        providerID: model.providerID,
        id: model.id,
        name: model.name,
        cost: model.cost?.[0]?.input,
        contextLimit: model.limit?.context,
        enabled: model.enabled,
      }))
    } catch (error) {
      this.#log.warn(`model list failed: ${errorText(error)}`)
      return []
    }
  }

  async #handleAgent(conversationId: string, argument: string): Promise<void> {
    const binding = this.#state.bindings[conversationId]
    if (!binding) {
      await this.#send(conversationId, "当前没有会话。先发一条消息或 /new。")
      return
    }

    let agents: AgentSummary[] = []
    try {
      agents = unwrapList<AgentSummary>(await this.#ctx.agent.list())
    } catch (error) {
      this.#log.warn(`agent list failed: ${errorText(error)}`)
    }

    if (!argument) {
      await this.#send(conversationId, formatAgentList(agents, binding.agent))
      return
    }

    const target = resolveAgentTarget(agents, argument)
    if (!target) {
      await this.#send(conversationId, `没找到 agent：${argument}`)
      return
    }

    try {
      await this.#ctx.session.switchAgent({ sessionID: binding.sessionID, agent: target.id })
      this.#state = updateState((state) => {
        const current = state.bindings[conversationId]
        if (current) state.bindings[conversationId] = { ...current, agent: target.id }
      })
      await this.#send(conversationId, `✅ 已切换 agent：${target.id}`)
    } catch (error) {
      await this.#send(conversationId, `❌ 切换失败：${errorText(error)}`)
    }
  }

  async #describeCost(conversationId: string): Promise<string> {
    const binding = this.#state.bindings[conversationId]
    if (!binding) return "当前没有会话。"

    const remote = this.#api.available ? await this.#api.getSession(binding.sessionID) : undefined
    const info = (await this.#ctx.session.get({ sessionID: binding.sessionID }).catch(() => undefined)) as
      | { cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }
      | undefined

    const cost = remote?.cost ?? info?.cost
    const tokens = info?.tokens
    if (cost === undefined && !tokens) return "拿不到用量信息。"

    const lines = ["💰 当前会话用量"]
    if (typeof cost === "number") lines.push(`花费：$${cost.toFixed(4)}`)
    if (tokens) {
      lines.push(
        `输入：${tokens.input ?? 0}（缓存读 ${tokens.cache?.read ?? 0} / 写 ${tokens.cache?.write ?? 0}）`,
        `输出：${tokens.output ?? 0}　推理：${tokens.reasoning ?? 0}`,
      )
    }
    return lines.join("\n")
  }

  async #handleDirectory(conversationId: string, argument: string): Promise<void> {
    if (!argument) {
      await this.#send(
        conversationId,
        `当前默认目录：${this.#defaultDirectory()}\n当前会话目录：${this.#state.bindings[conversationId]?.directory ?? "（还没建会话）"}\n\n用法：/dir D:\\code\\project`,
      )
      return
    }
    const candidate = this.#resolveUserPath(argument, conversationId)
    const stats = await fs.stat(candidate).catch(() => undefined)
    if (!stats?.isDirectory()) {
      await this.#send(conversationId, `目录不存在：${candidate}`)
      return
    }
    this.#state = updateState((state) => {
      state.defaultDirectory = candidate
    })
    await this.#send(conversationId, `✅ 默认目录已设为\n${candidate}\n用 /new 在这个目录里开新会话。`)
  }

  /**
   * `/more`: fetch what is stuck, or genuinely ask the model to continue.
   *
   * The two cases look identical to the user but need different actions: queued
   * text only needs the reply window to be open, while an answer that really was
   * cut off needs the model. Sending "继续" as an ordinary message does both at
   * once — which is how a nudge turns into "继续什么？".
   */
  async #more(conversationId: string): Promise<void> {
    const left = this.#queueFor(conversationId).length
    if (left > 0) {
      // The inbound that carried this command already tried to flush: text is
      // still queued, so the window is shut and only talking helps.
      await this.#send(
        conversationId,
        `还有 ${left} 条发不出去（窗口没开）。你再说一句话我就补发；想放弃可以发 /queue clear。`,
      )
      return
    }

    // Anything stuck was delivered moments ago by the inbound flush. Continuing
    // now would duplicate what the user is reading, so explain instead — a
    // second /more then means "keep writing".
    if (Date.now() - (this.#lastFlushedAt.get(conversationId) ?? 0) < MORE_DELIVERY_WINDOW_MS) {
      await this.#send(
        conversationId,
        "✅ 上面卡住的内容已经补发了。如果确实还有没写完的部分，再发一次 /more 我就让模型接着写。",
      )
      return
    }

    const binding = this.#state.bindings[conversationId]
    if (!binding) {
      await this.#send(conversationId, "当前没有会话。")
      return
    }
    try {
      await this.#ctx.session.prompt({ sessionID: binding.sessionID, text: CONTINUE_HINT })
    } catch (error) {
      await this.#send(conversationId, `❌ 续写请求失败：${errorText(error)}`)
      return
    }
    await this.#setTyping(conversationId, true)
    this.#typingSessions.set(binding.sessionID, conversationId)
  }

  async #retryQueued(conversationId: string): Promise<void> {
    const queued = this.#queueFor(conversationId)
    if (queued.length === 0) {
      await this.#send(conversationId, "没有待发消息。")
      return
    }
    this.#setRetryAttempt(conversationId, 0)
    await this.#flushQueue(conversationId)
    const remaining = this.#queueFor(conversationId)
    await this.#send(conversationId, remaining.length === 0 ? "✅ 待发消息已全部送出。" : `仍有 ${remaining.length} 条发不出去。`)
  }

  async describeStatus(): Promise<string> {
    const account = this.#state.account
    const lines = [
      "📡 opencode 微信通道",
      `连接：${this.ownsPoller ? "正在长轮询" : "本实例未持有轮询锁"}`,
      `机器人：${account?.accountId ?? "未登录"}${account && !account.token ? "（token 已失效，需重新登录）" : ""}`,
      `绑定微信：${account?.userId ?? "未知"}`,
      `游标：${this.#state.syncBuf ? "已保存" : "无"}`,
      `网络：${this.#describeNetwork()}`,
      `默认目录：${this.#defaultDirectory()}`,
      `进度提示：${this.#config.progress === "tools" ? "显示工具调用" : "关闭"}`,
      `回复延迟：文本结束后最多等 ${this.#config.turnGraceMs} 毫秒（grace）`,
      `实时推送：${this.#config.stream === "live" ? `开（每 ${Math.round(this.#config.streamIntervalMs / 1000)}s）` : "关"}`,
      `待审批：${this.#pendingPermissions.length}　待回答：${this.#pendingForms.length}`,
      `待发消息：${this.#queueFor(this.#state.lastConversation ?? "").length}`,
      `会话数：${Object.keys(this.#state.bindings).length}`,
      `自动跟随：${this.#config.followActive ? "开（跟电脑上正在用的会话）" : "关"}`,
      `本地 API：${this.#api.available ? (this.#api.isSelf ? "可用（本进程）" : "可用（注册文件指向其它进程）") : "不可用"}`,
    ]
    return lines.join("\n")
  }

  /** Health of the long-poll path, for `/status`. */
  #describeNetwork(): string {
    if (!this.#monitor) return "轮询器未运行"
    const silentFor = Math.max(0, Math.round((Date.now() - this.#monitor.lastResponseAt) / 1000))
    if (this.#monitor.consecutiveTimeouts === 0) return `正常（上次应答 ${silentFor} 秒前）`
    return `${this.#monitor.consecutiveTimeouts} 次长轮询无应答（最后应答 ${silentFor} 秒前）`
  }

  #logTail(lines: number): string {
    try {
      const content = readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean)
      return ["📜 最近日志：", "```", ...content.slice(-Math.max(1, Math.min(lines, 100))), "```"].join("\n")
    } catch {
      return "读不到日志文件。"
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Permissions
   * -------------------------------------------------------------------------
   */

  async #maybeHandlePermissionReply(conversationId: string, text: string): Promise<boolean> {
    const pending = this.#pendingPermissions.filter((item) => item.conversationId === conversationId)
    if (pending.length === 0) return false

    const decision = parseDecision(text)
    if (!decision) return false

    await this.#replyPermission(conversationId, pending[0], decision)
    return true
  }

  async #resolveQueuedPermission(
    conversationId: string,
    argument: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const pending = this.#pendingPermissions.filter((item) => item.conversationId === conversationId)
    if (pending.length === 0) {
      await this.#send(conversationId, "当前没有待审批的请求。")
      return
    }

    const selector = parseSelector(argument)
    if (selector.invalid) {
      await this.#send(conversationId, `看不懂序号：${argument}（用 /allow 序号、/deny 序号，或 /allow all）`)
      return
    }
    if (selector.all) {
      for (const item of pending) await this.#replyPermission(conversationId, item, decision)
      await this.#send(conversationId, `✅ 已对 ${pending.length} 个请求执行：${DECISION_LABEL[decision]}`)
      return
    }

    const target = selector.index ? pending[selector.index - 1] : pending[0]
    if (!target) {
      await this.#send(conversationId, `没有第 ${selector.index} 个待审批。`)
      return
    }
    await this.#replyPermission(conversationId, target, decision)
  }

  async #replyPermission(conversationId: string, request: PendingPermission, decision: PermissionDecision): Promise<void> {
    try {
      // The field is `decision` in the generated client, even though the docs
      // example spells it `reply`; passing the wrong name makes the call a
      // no-op that leaves the request pending forever.
      await this.#ctx.permission.reply({
        sessionID: request.sessionID,
        requestID: request.requestID,
        decision,
      })
      this.#pendingPermissions = this.#pendingPermissions.filter((item) => item !== request)
      await this.#send(conversationId, `✅ 已回复：${DECISION_LABEL[decision]}（${describeAction(request.action)}）`)
      if (this.#pendingPermissions.some((item) => item.conversationId === conversationId)) {
        await this.#send(conversationId, formatPendingSummary(this.#pendingPermissions.filter((item) => item.conversationId === conversationId)))
      }
    } catch (error) {
      await this.#send(conversationId, `❌ 审批回复失败：${errorText(error)}`)
    }
  }

  async #handlePermissionAsked(data: {
    id: string
    sessionID: string
    action: string
    resources?: string[]
    message?: string
  }): Promise<void> {
    const conversationId = this.#conversationForSession(data.sessionID)
    if (!conversationId) return

    const request: PendingPermission = {
      conversationId,
      sessionID: data.sessionID,
      requestID: data.id,
      action: data.action,
      resources: data.resources ?? [],
      createdAt: Date.now(),
      announced: false,
    }
    // The same request can be delivered twice (a redelivery, a re-subscribed
    // event stream). Two entries meant two announcements, a bare "1" settling
    // only one of them, and `/allow` failing on the twin.
    if (this.#pendingPermissions.some((item) => item.requestID === request.requestID)) {
      this.#log.info(`ignored a duplicate permission.asked for ${request.requestID}`)
      return
    }
    this.#pendingPermissions.push(request)
    while (this.#pendingPermissions.length > MAX_PENDING_PERMISSIONS) {
      const dropped = this.#pendingPermissions.shift()
      if (dropped) {
        // Dropping shifts every index, so it must never be silent.
        this.#log.warn(`too many pending approvals (${MAX_PENDING_PERMISSIONS}); dropped the oldest (${dropped.requestID})`)
      }
    }

    // An agent that needs three things approved asks three times in a row; the
    // user should get one message, not three. Wait a moment for the burst to
    // finish before announcing.
    if (this.#permissionBurst) clearTimeout(this.#permissionBurst)
    this.#permissionBurst = setTimeout(() => {
      this.#permissionBurst = undefined
      void this.#announcePendingPermissions().catch((error) =>
        this.#log.warn(`approval announcement failed: ${errorText(error)}`),
      )
    }, this.#config.approvalBurstMs || PERMISSION_BURST_MS)
    this.#permissionBurst.unref?.()
  }

  /** Send one message per conversation covering everything not yet announced. */
  async #announcePendingPermissions(): Promise<void> {
    const byConversation = new Map<string, PendingPermission[]>()
    for (const request of this.#pendingPermissions) {
      if (request.announced) continue
      const list = byConversation.get(request.conversationId) ?? []
      list.push(request)
      byConversation.set(request.conversationId, list)
    }

    for (const [conversationId, requests] of byConversation) {
      for (const request of requests) request.announced = true
      const binding = this.#state.bindings[conversationId]
      // Number against the whole pending list, so a digit means the same request
      // now (bare reply) and later (`/allow <n>`); numbering just this burst
      // used to shift every index whenever older approvals were still waiting.
      const pending = this.#pendingPermissions.filter((item) => item.conversationId === conversationId)
      const positions = requests.map((item) => pending.indexOf(item) + 1)
      if (requests.length === 1) {
        const request = requests[0]!
        await this.#send(
          conversationId,
          formatPermissionPrompt(request, positions[0] ?? 1, pending.length, binding?.title),
        )
        continue
      }
      await this.#send(conversationId, formatPermissionBatch(requests, positions, pending.length, binding?.title))
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Forms (the agent's interactive questions)
   * -------------------------------------------------------------------------
   */

  async #answerForm(conversationId: string, rawArgument: string): Promise<void> {
    const pending = this.#pendingForms.filter((item) => item.conversationId === conversationId)
    if (pending.length === 0) {
      await this.#send(conversationId, "当前没有待回答的问题。")
      return
    }

    // `/answer #2 是` targets the second pending form. Without a selector the
    // first one is used, which used to make a second form answerable only after
    // the first was dealt with — and silently validated against the wrong fields.
    let argument = rawArgument.trim()
    let index = 0
    const selector = /^#(\d+)\s*(.*)$/s.exec(argument)
    if (selector) {
      index = Number.parseInt(selector[1] ?? "1", 10) - 1
      argument = (selector[2] ?? "").trim()
      if (index < 0 || index >= pending.length) {
        await this.#send(conversationId, `只有 ${pending.length} 个待回答的问题（用 /answer #1 … #${pending.length}）。`)
        return
      }
    }
    const form = pending[index]!
    if (!argument) {
      await this.#send(
        conversationId,
        `用法：/answer 答案${pending.length > 1 ? `（或 /answer #1 … #${pending.length} 指定第几个）` : ""}`,
      )
      return
    }
    const resolved = resolveAnswer(form, argument)
    if ("error" in resolved) {
      await this.#send(conversationId, `⚠️ ${resolved.error}`)
      return
    }

    if (!this.#api.available) {
      await this.#send(conversationId, "本地 API 不可用，无法提交回答。请在电脑上作答。")
      return
    }

    const ok = await this.#api.replyForm(form.sessionID, form.formID, resolved.answer)
    if (!ok) {
      // A failed submit has two very different causes; ask the service which one
      // it is instead of guessing, and only drop the question when it is gone.
      const remote = await this.#api.getForm(form.sessionID, form.formID)
      if (!remote || (remote.state && remote.state.status !== "pending")) {
        this.#pendingForms = this.#pendingForms.filter((item) => item !== form)
        await this.#send(conversationId, "❌ 这个提问已经过期或被取消了。")
        return
      }
      await this.#send(
        conversationId,
        "❌ 提交被拒绝：可能是必填项没填或格式不对。可以重新 /answer（这个提问仍然有效）。",
      )
      return
    }

    this.#pendingForms = this.#pendingForms.filter((item) => item !== form)
    await this.#send(conversationId, describeAnswer(form, resolved.summary))
    const remaining = this.#pendingForms.filter((item) => item.conversationId === conversationId)
    if (remaining.length > 0) {
      for (const [index, next] of remaining.entries()) {
        await this.#send(conversationId, formatFormPrompt(next, index + 1, remaining.length))
      }
    }
  }

  async #handleFormCreated(form: ApiForm): Promise<void> {
    const conversationId = this.#conversationForSession(form.sessionID)
    if (!conversationId) return
    if (form.state && form.state.status !== "pending") return

    const pending: PendingForm = {
      conversationId,
      sessionID: form.sessionID,
      formID: form.id,
      title: form.title,
      fields: form.fields ?? [],
      createdAt: Date.now(),
    }
    this.#pendingForms = this.#pendingForms.filter((item) => item.formID !== form.id)
    this.#pendingForms.push(pending)

    const queue = this.#pendingForms.filter((item) => item.conversationId === conversationId)
    await this.#send(conversationId, formatFormPrompt(pending, queue.length, queue.length))
  }

  /*
   * -------------------------------------------------------------------------
   * Events
   * -------------------------------------------------------------------------
   */

  /** Handle one server event. Only the poller owner subscribes. */
  async handleEvent(event: { type?: string; data?: unknown }): Promise<void> {
    const type = event.type
    if (!type) return
    // Log every event type once per process. When the host renames something
    // (as it did for the turn's end signal — `session.idle` never arrived in
    // 2.0.2x) this line is what makes it visible instead of silent.
    if (!this.#seenEventTypes.has(type)) {
      this.#seenEventTypes.add(type)
      this.#log.info(`event type seen for the first time: ${type}`)
    }
    const data = (event.data ?? {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined

    switch (type) {
      case "session.text.delta": {
        if (!sessionID) return
        const delta = typeof data.delta === "string" ? data.delta : ""
        const conversationId = this.#conversationForSession(sessionID)
        if (!conversationId || !delta) return
        this.#pushLive(sessionID, conversationId, delta)
        return
      }

      case "session.text.ended": {
        if (!sessionID) return
        const text = typeof data.text === "string" ? data.text : ""
        if (!text.trim()) return
        const conversationId = this.#conversationForSession(sessionID)
        if (!conversationId) return
        // Always assembled, even in live mode: if a streamed fragment never made
        // it out, this is the only complete copy of the text.
        this.#bufferTurn(sessionID, conversationId, text)
        return
      }

      case "session.tool.called": {
        if (this.#config.progress !== "tools" || !sessionID) return
        const conversationId = this.#conversationForSession(sessionID)
        if (!conversationId) return
        const name = typeof data.id === "string" ? data.id : "tool"
        if (name.startsWith("wechat_")) return
        const summary = summarizeToolInput(data.input)
        await this.#sendEphemeral(conversationId, `🔧 ${name}${summary ? `: ${summary}` : ""}`)
        return
      }

      case "session.tool.failed": {
        // Gated by the same switch as tool progress: a failing agent loop would
        // otherwise flood the chat and consume the reply window the answer needs.
        if (this.#config.progress !== "tools" || !sessionID) return
        const conversationId = this.#conversationForSession(sessionID)
        if (!conversationId) return
        const name = typeof data.id === "string" ? data.id : "tool"
        if (name.startsWith("wechat_")) return
        const error = (data.error ?? {}) as { message?: string; type?: string }
        const detail = String(error.message ?? error.type ?? "失败").replace(/\s+/g, " ").slice(0, 140)
        await this.#sendEphemeral(conversationId, `❌ ${name} 失败：${detail}`)
        return
      }

      case "session.text.started":
      case "session.execution.started": {
        // A new turn began: the settle shortcut belongs to the previous one.
        if (sessionID) this.#settledTurns.delete(sessionID)
        return
      }

      case "session.idle":
      case "session.execution.succeeded": {
        // Both mean "the turn is over". `session.execution.succeeded` is the
        // durable one and does arrive; `session.idle` is kept as a fallback.
        if (sessionID) await this.#finishTurnSoon(sessionID)
        return
      }

      case "session.status": {
        if (!sessionID) return
        const status = (data.status ?? {}) as { type?: string; attempt?: number; message?: string } | string
        const kind = typeof status === "string" ? status : status.type
        if (kind === "idle") {
          await this.#finishTurnSoon(sessionID)
          return
        }
        if (kind === "busy") {
          this.#settledTurns.delete(sessionID)
          return
        }
        if (kind === "retry") {
          const attempt = typeof status === "object" && typeof status.attempt === "number" ? status.attempt : 0
          const reason = typeof status === "object" ? String(status.message ?? "").slice(0, 80) : ""
          this.#log.info(`provider retry for ${sessionID.slice(0, 16)}: attempt ${attempt}${reason ? ` (${reason})` : ""}`)
          // A silent multi-minute retry loop looks like a hang from the phone;
          // nudge twice and let the normal progress setting keep it quiet.
          if ((attempt === 2 || attempt === 5) && this.#config.progress !== "off") {
            const conversationId = this.#conversationForSession(sessionID)
            if (conversationId) {
              await this.#sendEphemeral(conversationId, `⚠️ 模型请求失败，正在第 ${attempt} 次重试${reason ? `：${reason}` : ""}`)
            }
          }
          return
        }
        return
      }

      case "session.execution.failed": {
        if (!sessionID) return
        const conversationId = this.#conversationForSession(sessionID)
        if (!conversationId) return
        const error = (data.error ?? {}) as { message?: string; type?: string }
        await this.#finishTurn(sessionID, "failed")
        await this.#send(conversationId, `❌ 执行失败：${error.message ?? error.type ?? "未知错误"}`)
        return
      }

      case "permission.asked": {
        await this.#handlePermissionAsked(
          data as unknown as { id: string; sessionID: string; action: string; resources?: string[]; message?: string },
        )
        return
      }

      case "permission.replied": {
        const requestID = typeof data.requestID === "string" ? data.requestID : undefined
        if (requestID) this.#pendingPermissions = this.#pendingPermissions.filter((item) => item.requestID !== requestID)
        return
      }

      case "form.created": {
        const form = (data.form ?? data) as ApiForm
        if (form?.id && form?.sessionID) await this.#handleFormCreated(form)
        return
      }

      case "form.replied":
      case "form.cancelled": {
        const formID = typeof data.id === "string" ? data.id : undefined
        if (formID) this.#pendingForms = this.#pendingForms.filter((item) => item.formID !== formID)
        return
      }

      default:
        return
    }
  }

  #bufferTurn(sessionID: string, conversationId: string, text: string): void {
    const existing = this.#turns.get(sessionID)
    const entry = existing ?? { conversationId, parts: [] }
    entry.parts.push(text)
    if (entry.timer) clearTimeout(entry.timer)
    // A block that arrives after the turn's end signal only needs the short
    // settle window; without a signal the full grace applies so the blocks of a
    // still-running turn can merge.
    const delay = this.#settledTurns.has(sessionID)
      ? Math.min(this.#config.turnSettleMs, this.#config.turnGraceMs)
      : this.#config.turnGraceMs
    entry.timer = setTimeout(
      () =>
        void this.#finishTurn(sessionID, this.#settledTurns.has(sessionID) ? "idle" : "timer").catch((error) =>
          this.#log.warn(`turn flush failed: ${errorText(error)}`),
        ),
      delay,
    )
    entry.timer.unref?.()
    this.#turns.set(sessionID, entry)
  }

  /**
   * A turn-completion signal arrived: shorten the pending wait.
   *
   * The final text block can arrive just after the signal, so this does not
   * flush immediately — it replaces the full grace (`turnGraceMs`, 3 s) with the
   * short settle window (`turnSettleMs`, 0.6 s). Every reply used to pay the
   * full grace because the only signal the host actually sent was unreliable.
   */
  async #finishTurnSoon(sessionID: string): Promise<void> {
    this.#settledTurns.add(sessionID)
    const settle = Math.max(0, Math.min(this.#config.turnSettleMs, this.#config.turnGraceMs))
    const turn = this.#turns.get(sessionID)
    const live = this.#live.get(sessionID)
    if (!turn && !live) return
    if (settle <= 0) {
      // Nothing to wait for: flush now, and let the caller await it.
      await this.#finishTurn(sessionID, "idle")
      return
    }
    const finish = (): void => {
      void this.#finishTurn(sessionID, "idle").catch((error) =>
        this.#log.warn(`turn flush failed: ${errorText(error)}`),
      )
    }
    const timer = setTimeout(finish, settle)
    timer.unref?.()
    if (turn) {
      if (turn.timer) clearTimeout(turn.timer)
      turn.timer = timer
      this.#turns.set(sessionID, turn)
      return
    }
    if (live) {
      // Live mode: the fragment interval is replaced by the one-shot settle.
      if (live.timer) clearInterval(live.timer)
      live.timer = timer
      this.#live.set(sessionID, live)
    }
  }

  /** A turn ended: deliver whatever is left and stop the "typing" indicator. */
  async #finishTurn(sessionID: string, trigger: "idle" | "timer" | "failed" = "idle"): Promise<void> {
    this.#settledTurns.delete(sessionID)
    const turn = this.#turns.get(sessionID)
    this.#turns.delete(sessionID)
    if (turn?.timer) clearTimeout(turn.timer)

    const live = this.#live.get(sessionID)
    this.#live.delete(sessionID)
    if (live?.timer) clearTimeout(live.timer)

    const conversationId = turn?.conversationId ?? live?.conversationId ?? this.#typingSessions.get(sessionID)
    this.#typingSessions.delete(sessionID)
    if (!conversationId) return

    await this.#setTyping(conversationId, false)

    if (live && live.sent > 0) {
      if (live.degraded) {
        // A streamed fragment was dropped, so the tail alone would be a
        // fragment: send the whole assembled turn instead.
        const full = (turn?.parts ?? []).join("\n\n").trim() || live.pending.trim()
        if (full) await this.#send(conversationId, renderForWechat(full))
        return
      }
      // Live mode delivered the text as it streamed; only the tail is left.
      const remaining = live.pending.trim()
      if (remaining) await this.#send(conversationId, renderForWechat(remaining))
      return
    }

    // Either streaming is off, or the turn produced no deltas at all (a turn can
    // be pure tool calls), in which case the assembled text is the only copy.
    const text = (turn?.parts ?? []).join("\n\n").trim()
    if (text) {
      // Which trigger delivered is worth recording: `timer` means the session's
      // idle signal did not arrive and the fallback did the work.
      this.#log.info(`reply sent (trigger: ${trigger}, ${turn?.parts.length ?? 0} block(s))`)
      await this.#send(conversationId, renderForWechat(text))
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Live streaming (optional)
   * -------------------------------------------------------------------------
   */

  #startLive(sessionID: string, conversationId: string): void {
    if (this.#config.stream !== "live") return
    // Never reset an in-flight stream: a second message can be steered into the
    // running turn, and wiping `sent` here would make the turn's final text look
    // unsent and get delivered twice.
    if (this.#live.has(sessionID)) return
    this.#live.set(sessionID, { conversationId, pending: "", sent: 0 })
  }

  #pushLive(sessionID: string, conversationId: string, delta: string): void {
    if (this.#config.stream !== "live") return
    const entry = this.#live.get(sessionID) ?? { conversationId, pending: "", sent: 0 }
    entry.pending += delta
    if (!entry.timer) {
      entry.timer = setInterval(() => {
        void this.#flushLive(sessionID).catch((error) =>
          this.#log.warn(`live flush failed: ${errorText(error)}`),
        )
      }, this.#config.streamIntervalMs)
      entry.timer.unref?.()
    }
    this.#live.set(sessionID, entry)
  }

  async #flushLive(sessionID: string): Promise<void> {
    const entry = this.#live.get(sessionID)
    if (!entry) return
    const text = renderForWechat(entry.pending).trim()
    entry.pending = ""
    if (!text) return
    // Track what is in flight so a stop mid-send neither loses the fragment nor
    // queues the whole turn behind it.
    entry.sending = text
    // Streaming fragments are not queued: a stale fragment arriving minutes
    // later is worse than a gap, and the assembled turn covers the gap.
    const refused = await this.#chain(entry.conversationId, () => this.#trySend(entry.conversationId, text))
    entry.sending = undefined
    if (refused) {
      entry.degraded = true
      this.#log.info(`streamed fragment dropped (errcode=${refused.errcode}); the full turn will be sent at the end`)
      return
    }
    entry.sent += text.length
  }

  /**
   * All conversations bound to one session.
   *
   * Usually one. The reverse lookup exists because a session can be re-bound by
   * `/switch`, and because an explicit push from the agent goes to the most
   * recent conversation.
   */
  #conversationForSession(sessionID: string): string | undefined {
    for (const [conversationId, binding] of Object.entries(this.#state.bindings)) {
      if (binding.sessionID === sessionID) return conversationId
    }
    return this.#config.mirrorAll ? this.#state.lastConversation : undefined
  }

  /*
   * -------------------------------------------------------------------------
   * Outbound
   * -------------------------------------------------------------------------
   */

  /** Send text to a conversation, splitting it and surviving a closed reply window. */
  async #send(conversationId: string, text: string): Promise<void> {
    await this.#sendReturning(conversationId, text)
  }

  /**
   * Send something that is only useful right now.
   *
   * Tool progress is a heartbeat, not a record: queueing it means the phone
   * gets a burst of stale "🔧 tool" lines minutes later, and retrying it wastes
   * the reply window that the finished answer needs. A failed ephemeral send is
   * logged and dropped.
   */
  async #sendEphemeral(conversationId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, this.#config.chunkSize)) {
      const refused = await this.#chain(conversationId, () => this.#trySend(conversationId, chunk))
      if (refused) this.#log.info(`dropped ephemeral message (errcode=${refused.errcode}): ${preview(chunk, 40)}`)
    }
  }

  /** Same as `#send`, but reports whether every chunk actually went out. */
  async #sendReturning(conversationId: string, text: string): Promise<boolean> {
    // A numbered part needs room for its `（i/N）` marker, so multi-part replies
    // are re-cut with a slightly smaller budget: the marker must never push a
    // chunk over the service's limit, or its tail would be dropped silently.
    const limit = this.#config.chunkSize
    let chunks = chunkText(text, limit)
    if (chunks.length > 1) chunks = numberChunks(chunkText(text, Math.max(64, limit - 12)))

    let delivered = true
    let queued = 0
    for (const chunk of chunks) {
      const ok = await this.sendChunk(conversationId, chunk)
      if (ok) continue
      delivered = false
      // Every refusal queues exactly one item, so this is what the user will
      // actually have to fetch — not a guess.
      queued += 1
    }

    if (queued > 0) {
      // Without a notice a half-delivered answer looks like the model stopped on
      // its own, and the user has no way to know that simply speaking fetches
      // the rest. Exactly one notice is kept, and its count comes from the queue.
      this.#ensureNotice(conversationId)
    }
    return delivered
  }

  /**
   * Keep at most one ⚠️ "not everything went out" notice at the head of a queue.
   *
   * The count is read off the queue itself (an earlier version guessed it from
   * the failed send and could over- or under-count), the notice never stacks,
   * and it is dropped as soon as its content is gone.
   */
  #ensureNotice(conversationId: string): void {
    const queue = this.#queueFor(conversationId)
    const content = queue.filter((item) => !item.text.startsWith(NOTICE_PREFIX))
    const hadNotice = content.length !== queue.length
    if (content.length === 0) {
      if (hadNotice) this.#setQueue(conversationId, [])
      return
    }
    const kept = content.slice(-QUEUE_LIMIT)
    if (kept.length < content.length) {
      this.#log.warn(`queue full: dropped ${content.length - kept.length} oldest item(s) for ${conversationId}`)
    }
    const notice: QueuedMessage = {
      text: `${NOTICE_PREFIX}（还有 ${kept.length} 段）。发一句话或 /more 我就把剩下的补上。`,
      clientId: newClientId(),
    }
    this.#setQueue(conversationId, [notice, ...kept])
  }

  /** Remove a stale notice (its content went out). */
  #stripNotice(conversationId: string): void {
    const queue = this.#queueFor(conversationId)
    if (!queue.some((item) => item.text.startsWith(NOTICE_PREFIX))) return
    this.#setQueue(
      conversationId,
      queue.filter((item) => !item.text.startsWith(NOTICE_PREFIX)),
    )
  }

  /**
   * Add items to a conversation's queue, keeping it bounded.
   *
   * The cap favours the newest items — the tail of a long answer matters more
   * than its first chunk — except for a prepended notice, which must survive so
   * the user still learns that something was cut. Either way the drop is logged,
   * never silent.
   */
  #enqueue(conversationId: string, items: Array<string | QueuedMessage>, atHead = false): void {
    const queue = this.#queueFor(conversationId)
    const prepared: QueuedMessage[] = items.map((item) =>
      typeof item === "string" ? { text: item, clientId: newClientId() } : item,
    )
    const merged = atHead ? [...prepared, ...queue] : [...queue, ...prepared]
    if (merged.length <= QUEUE_LIMIT) {
      this.#setQueue(conversationId, merged)
      return
    }
    const dropped = merged.length - QUEUE_LIMIT
    const head = atHead ? Math.min(prepared.length, QUEUE_LIMIT) : 0
    this.#log.warn(`queue full (${QUEUE_LIMIT}): dropped ${dropped} oldest item(s) for ${conversationId}`)
    this.#setQueue(conversationId, [
      ...merged.slice(0, head),
      ...merged.slice(merged.length - (QUEUE_LIMIT - head)),
    ])
  }

  /** Send to the most recently active conversation. Used by the tools. */
  async sendToLast(text: string): Promise<boolean> {
    this.reloadState()
    const conversationId = this.#state.lastConversation
    if (!conversationId) return false
    for (const chunk of chunkText(text, this.#config.chunkSize)) {
      // Refusals are queued by the send path; report the failure instead of
      // throwing, so the tool can tell the agent what to do next.
      const ok = await this.sendChunk(conversationId, chunk)
      if (!ok) return false
    }
    return true
  }

  /**
   * Send a local file to the most recent conversation.
   *
   * Images and videos are delivered natively; everything else as a file card.
   * The caption is sent first, so the phone shows context above the attachment.
   */
  async sendFileToLast(params: { filePath: string; caption?: string; kind?: OutboundKind }): Promise<string> {
    this.reloadState()
    const conversationId = this.#state.lastConversation
    if (!conversationId) return "还没有微信会话，先让用户发一条消息"
    return this.sendFile(conversationId, params)
  }

  async sendFile(
    conversationId: string,
    params: { filePath: string; caption?: string; kind?: OutboundKind },
  ): Promise<string> {
    const account = this.#state.account
    if (!account?.token) return "微信通道尚未登录"

    const peerId = conversationId.split(":").pop()
    if (!peerId) return "会话标识无效"

    const resolved = isAbsolute(params.filePath) ? params.filePath : resolvePath(params.filePath)
    const stats = await fs.stat(resolved).catch(() => undefined)
    if (!stats?.isFile()) return `文件不存在：${resolved}`

    const kind = params.kind ?? kindForPath(resolved)
    try {
      const attachment = await prepareAttachment({ account, filePath: resolved, toUserId: peerId, kind })
      const items = [
        ...(params.caption?.trim() ? [textItem(params.caption.trim())] : []),
        attachment.item,
      ]
      for (const item of items) {
        const refused = await this.#trySendItem(conversationId, item)
        if (refused) return `发送失败：${refused.message}`
      }
      this.#log.info(`sent ${kind} ${attachment.name} (${attachment.plainSize} bytes) to ${peerId.slice(0, 12)}…`)
      return `已发送${kind === "image" ? "图片" : kind === "video" ? "视频" : "文件"}：${attachment.name}（${(attachment.plainSize / 1024).toFixed(1)}KB）`
    } catch (error) {
      this.#log.warn(`send file failed: ${errorText(error)}`)
      return `发送失败：${errorText(error)}`
    }
  }

  /** One send attempt for a single item, with the no-context-token fallback. */
  async #trySendItem(conversationId: string, item: unknown): Promise<SendRefusedError | undefined> {
    return this.#chain(conversationId, () => this.#trySendItemNow(conversationId, item))
  }

  async #trySendItemNow(conversationId: string, item: unknown): Promise<SendRefusedError | undefined> {
    const account = this.#state.account
    if (!account?.token) return new SendRefusedError("微信通道尚未登录", LOCAL_FAILURE)
    const peerId = conversationId.split(":").pop()
    if (!peerId) return new SendRefusedError("会话标识无效", LOCAL_FAILURE)

    const contextToken = this.#state.contextTokens[conversationId]
    try {
      await sendItems({ account, to: peerId, items: [item as never], contextToken })
      return undefined
    } catch (error) {
      if (error instanceof SendRefusedError && contextToken) {
        try {
          await sendItems({ account, to: peerId, items: [item as never] })
          return undefined
        } catch {
          /* fall through */
        }
      }
      return error instanceof SendRefusedError ? error : new SendRefusedError(errorText(error), LOCAL_FAILURE)
    }
  }

  /**
   * One send attempt for text.
   *
   * A refusal usually means the reply window for that context token is closed.
   * A message without the token is accepted by the service, so that is tried
   * before giving up — but it is not logged as a success story, because the
   * refusal itself is the interesting fact.
   */
  async #trySend(conversationId: string, chunk: string, clientId?: string): Promise<SendRefusedError | undefined> {
    if (!this.#state.account?.token) this.reloadState()
    const account = this.#state.account
    if (!account?.token) return new SendRefusedError("微信通道尚未登录", LOCAL_FAILURE)

    const peerId = conversationId.split(":").pop()
    if (!peerId) return new SendRefusedError("会话标识无效", LOCAL_FAILURE)

    const contextToken = this.#state.contextTokens[conversationId]
    try {
      await sendText({ account, to: peerId, text: chunk, contextToken, clientId })
      this.#log.info(`sent ${chunk.length} chars to ${peerId.slice(0, 12)}…: ${preview(chunk)}`)
      return undefined
    } catch (error) {
      if (!(error instanceof SendRefusedError)) {
        this.#log.warn(`send failed: ${errorText(error)}`)
        return new SendRefusedError(`发送失败：${errorText(error)}`, LOCAL_FAILURE)
      }
      if (contextToken) {
        try {
          // Same client id: the fallback is the same logical message, so a
          // server that already accepted the first attempt dedupes this one.
          await sendText({ account, to: peerId, text: chunk, clientId })
          this.#log.info(`sent ${chunk.length} chars without context token: ${preview(chunk)}`)
          return undefined
        } catch {
          // Fall through to the refusal below.
        }
      }
      return error
    }
  }

  /**
   * Send a chunk, queueing it when the service refuses.
   *
   * Sends for one conversation are chained: the agent pushing a message, a
   * permission prompt and a finished turn can all fire at once, and without
   * ordering their chunks would interleave on the phone.
   */
  async sendChunk(conversationId: string, chunk: string, throwOnFailure = false): Promise<boolean> {
    const clientId = newClientId()
    return this.#chain(conversationId, () => this.#sendChunkNow(conversationId, chunk, clientId, throwOnFailure))
  }

  /**
   * Run one outbound task after everything already queued for this conversation.
   *
   * Every send goes through here — answers, tool progress, live fragments, queue
   * flushes and attachments — because otherwise a `🔧 bash: …` line lands in the
   * middle of a numbered reply.
   */
  #chain<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#sendChains.get(conversationId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.#sendChains.set(
      conversationId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  async #sendChunkNow(
    conversationId: string,
    chunk: string,
    clientId: string,
    throwOnFailure: boolean,
  ): Promise<boolean> {
    const refused = await this.#trySend(conversationId, chunk, clientId)
    if (!refused) {
      if (this.#config.sendDelayMs > 0) await delay(this.#config.sendDelayMs)
      return true
    }

    // Queued with the id the failed attempt already used: the service dedupes on
    // it, so an ambiguous timeout ("possibly delivered") cannot land twice.
    this.#enqueue(conversationId, [{ text: chunk, clientId }])
    if (refused.errcode === LOCAL_FAILURE) {
      // Not a protocol refusal: the request may have reached the service before
      // the connection broke, so the retry can duplicate the message.
      this.#log.warn(`send failed (possibly delivered): ${refused.message}`)
    } else {
      this.#log.warn(`send refused (errcode=${refused.errcode}): ${refused.message} | 内容：${preview(chunk, 60)}`)
    }
    this.#scheduleRetry(conversationId)
    if (throwOnFailure) throw refused
    return false
  }

  /*
   * -------------------------------------------------------------------------
   * Outbound queue (persisted)
   * -------------------------------------------------------------------------
   */

  /** Text waiting to be delivered to a conversation (legacy string entries are migrated). */
  #queueFor(conversationId: string): QueuedMessage[] {
    const raw = this.#state.pendingOutbound?.[conversationId] ?? []
    let migrated = false
    const items = raw.map((entry) => {
      if (typeof entry !== "string") return entry
      migrated = true
      // Entries written before ids existed get one now, so their retries are
      // deduped from this point on.
      return { text: entry, clientId: newClientId() }
    })
    if (migrated) this.#setQueue(conversationId, items)
    return items
  }

  #setQueue(conversationId: string, items: QueuedMessage[]): void {
    this.#state = updateState((state) => {
      const next = { ...(state.pendingOutbound ?? {}) }
      const since = { ...(state.pendingOutboundSince ?? {}) }
      if (items.length === 0) {
        delete next[conversationId]
        delete since[conversationId]
      } else {
        next[conversationId] = items
        // First write of this queue: remember when it appeared, so a parked
        // queue nobody ever claims can expire instead of living in the state
        // file forever.
        if (since[conversationId] === undefined) since[conversationId] = Date.now()
      }
      state.pendingOutbound = next
      state.pendingOutboundSince = since
    })
  }

  #retryAttempt(conversationId: string): number {
    return this.#state.pendingOutboundAttempts?.[conversationId] ?? 0
  }

  #setRetryAttempt(conversationId: string, attempt: number): void {
    this.#state = updateState((state) => {
      const next = { ...(state.pendingOutboundAttempts ?? {}) }
      if (attempt <= 0) delete next[conversationId]
      else next[conversationId] = attempt
      state.pendingOutboundAttempts = next
    })
  }

  /** Drop everything queued for a conversation, returning how much was dropped. */
  #dropQueue(conversationId: string): number {
    const queued = this.#queueFor(conversationId)
    this.#setQueue(conversationId, [])
    this.#setRetryAttempt(conversationId, 0)
    // Tell a flush that is in flight that this queue is gone.
    this.#queueGenerations.set(conversationId, (this.#queueGenerations.get(conversationId) ?? 0) + 1)
    const timer = this.#retryTimers.get(conversationId)
    if (timer) {
      clearTimeout(timer)
      this.#retryTimers.delete(conversationId)
    }
    return queued.length
  }

  /** Retry a conversation's queue with growing delays, then park it. */
  #scheduleRetry(conversationId: string): void {
    if (this.#retryTimers.has(conversationId)) return
    const backoff = this.#config.retryBackoffMs.length > 0 ? this.#config.retryBackoffMs : [5_000]
    const attempt = this.#retryAttempt(conversationId)
    if (attempt >= backoff.length) {
      // Out of retries: the window has been closed for a long time, and a fresh
      // inbound message is the only reliable way to reopen it. Park the queue
      // instead of hammering an endpoint that keeps refusing.
      const parked = this.#queueFor(conversationId).length
      this.#log.warn(`parked ${parked} queued message(s); they will be delivered after the next inbound message`)
      return
    }
    const delayMs = backoff[Math.min(attempt, backoff.length - 1)]
    this.#setRetryAttempt(conversationId, attempt + 1)
    const timer = setTimeout(() => {
      this.#retryTimers.delete(conversationId)
      void this.#flushQueue(conversationId).catch((error) =>
        this.#log.warn(`queued flush failed: ${errorText(error)}`),
      )
    }, delayMs)
    timer.unref?.()
    this.#retryTimers.set(conversationId, timer)
  }

  /**
   * Try to deliver everything queued for a conversation.
   *
   * The queue is taken out atomically before sending: anything appended while a
   * send is in flight (a new chunk, a notice, a `/queue clear`) lands in a fresh
   * queue and is not overwritten when the tail is put back. A per-conversation
   * mutex keeps two flushes (retry timer + inbound) from sending the same item
   * twice, and a generation counter makes a `/queue clear` during a flush stick.
   */
  async #flushQueue(conversationId: string): Promise<void> {
    if (this.#flushing.has(conversationId)) return
    const batch = this.#queueFor(conversationId)
    if (batch.length === 0) {
      this.#setRetryAttempt(conversationId, 0)
      return
    }

    const generation = this.#queueGenerations.get(conversationId) ?? 0
    let delivered = 0
    let refusedAt = -1
    try {
      // Inside the try: a throwing state write here used to leave `#flushing`
      // set forever, stalling this conversation's queue until a restart.
      this.#flushing.add(conversationId)
      for (const [index, item] of batch.entries()) {
        // Persist the remainder *before* sending: a crash or a reload mid-flush
        // then loses at most the in-flight item — and that one carries a stable
        // client id, so even a delivered-but-unacknowledged retry is deduped.
        this.#setQueue(conversationId, batch.slice(index + 1))
        const refused = await this.#chain(conversationId, () =>
          this.#trySend(conversationId, item.text, item.clientId),
        )
        // Dropped while we were sending (`/cancel all`, `/queue clear`): the
        // caller's generation check below must not resurrect it.
        if ((this.#queueGenerations.get(conversationId) ?? 0) !== generation) return
        if (refused) {
          this.#log.warn(`queued send still refused (errcode=${refused.errcode})`)
          refusedAt = index
          break
        }
        delivered += 1
        this.#log.info("queued send delivered")
      }
    } finally {
      this.#flushing.delete(conversationId)
    }

    if (delivered > 0) this.#lastFlushedAt.set(conversationId, Date.now())

    if (refusedAt < 0) {
      // Everything went out: a "parts are missing" notice would now be a lie.
      this.#stripNotice(conversationId)
      this.#setRetryAttempt(conversationId, 0)
      if (this.#queueFor(conversationId).length > 0) this.#scheduleRetry(conversationId)
      return
    }

    // Dropped while we were sending: do not resurrect it.
    if ((this.#queueGenerations.get(conversationId) ?? 0) !== generation) return

    const appended = this.#queueFor(conversationId)
    const merged = [...batch.slice(refusedAt), ...appended]
    if (merged.length > QUEUE_LIMIT) {
      // Never silent: the dropped items are the oldest, which may be the very
      // tail this flush was trying to deliver.
      this.#log.warn(`queue over ${QUEUE_LIMIT} after a flush: dropping ${merged.length - QUEUE_LIMIT} oldest item(s)`)
    }
    this.#setQueue(conversationId, merged.slice(-QUEUE_LIMIT))
    // Re-derive the notice from what is really queued now.
    this.#ensureNotice(conversationId)
    this.#scheduleRetry(conversationId)
  }

  /*
   * -------------------------------------------------------------------------
   * Typing indicator
   * -------------------------------------------------------------------------
   */

  async #setTyping(conversationId: string, typing: boolean): Promise<void> {
    if (!typing) {
      // Cleared before the token check: with the credential gone (`-14`,
      // `--logout`) that early return used to leave the 12 s refresh running
      // forever, posting "typing…" with an account that no longer exists.
      const timer = this.#typingTimers.get(conversationId)
      if (timer) {
        clearInterval(timer)
        this.#typingTimers.delete(conversationId)
      }
    }
    const account = this.#state.account
    if (!account?.token) return
    const peerId = conversationId.split(":").pop()
    if (!peerId) return

    const ticket = this.#typingTickets.get(peerId) ?? (await this.#fetchTypingTicket(peerId))
    if (!ticket) return

    try {
      await sendTyping({ account, userId: peerId, ticket, typing })
    } catch (error) {
      this.#log.warn(`typing failed: ${errorText(error)}`)
      return
    }

    if (!typing || this.#typingTimers.has(conversationId)) return
    // The indicator expires on its own; refresh while the turn runs — with a
    // hard stop, so a turn that never reports an end cannot leave it on forever.
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > TYPING_MAX_MS) {
        clearInterval(timer)
        this.#typingTimers.delete(conversationId)
        return
      }
      void sendTyping({ account, userId: peerId, ticket, typing: true }).catch(() => {})
    }, 12_000)
    timer.unref?.()
    this.#typingTimers.set(conversationId, timer)
  }

  async #fetchTypingTicket(peerId: string): Promise<string | undefined> {
    const account = this.#state.account
    if (!account?.token) return undefined
    try {
      const ticket = await getTypingTicket({ account, userId: peerId })
      this.#typingTickets.set(peerId, ticket)
      return ticket
    } catch (error) {
      this.#log.warn(`getconfig failed: ${errorText(error)}`)
      this.#typingTickets.set(peerId, undefined)
      return undefined
    }
  }

  /** Best-effort shutdown notice so the backend knows the bot went away. */
  async announceStop(): Promise<void> {
    const account = this.#state.account
    if (!account?.token) return
    await notifyStop(account)
  }
}

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

const LOG_PATH = join(STATE_DIR, "bridge.log")

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Normalise a user-typed argument for numeric/keyword comparisons.
 *
 * NFKC folds full-width digits and slashes (`２` → `2`) so an argument typed with
 * a Chinese IME reaches the same handler as an ASCII one.
 */
function normalizeArgument(value: string): string {
  return value.normalize("NFKC").trim()
}

/** Strip one matching pair of surrounding quotes: `"D:\code repo"` → `D:\code repo`. */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  const match = /^(['"])([\s\S]*)\1$/.exec(trimmed)
  return match ? (match[2] ?? "") : trimmed
}

/**
 * Whether a message is a command.
 *
 * Checked on the NFKC-folded text so the full-width slash a Chinese IME emits
 * (`／列表`) reaches the command handler instead of being sent to the model.
 */
function looksLikeCommand(text: string): boolean {
  return text.normalize("NFKC").trimStart().startsWith("/")
}

/** One-line, length-capped excerpt for log lines.
 *
 * Credential shapes are redacted first: users paste tokens and passwords into
 * chats, the log is written to disk unencrypted, and `/log` ships its tail back
 * into the chat.
 */
function preview(text: string, limit = 80): string {
  return redactSecrets(text.replace(/\s+/g, " ").trim()).slice(0, limit)
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "filePath", "path", "pattern", "url", "query", "description"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.replace(/\s+/g, " ").slice(0, 100)
  }
  return ""
}

/** WeChat renders plain text: drop control characters and collapse blank runs. */
export function renderForWechat(text: string): string {
  return text
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Split a long answer into chunks the service will accept.
 *
 * Two rules matter: no chunk may exceed the per-message limit (the tail of an
 * oversized message is silently dropped on the phone), and splitting must not
 * lose a character. Lines are the preferred boundary; a line that is longer
 * than the limit by itself (a minified blob, a long URL, a paragraph with no
 * spaces) is cut, preferring a nearby break so words survive.
 */
export function chunkText(text: string, limit: number): string[] {
  const normalized = text.trim()
  if (normalized.length <= limit) return normalized ? [normalized] : []

  // A tiny limit could otherwise make the fence bookkeeping longer than a whole
  // chunk and loop forever; the smallest configured chunk is far above this.
  const budget = Math.max(limit, 32)
  const chunks: string[] = []
  let current = ""
  let fence = false

  const flush = (): void => {
    if (current.trim()) chunks.push(fence ? `${current}\n\`\`\`` : current)
    current = fence ? "```" : ""
  }

  const push = (piece: string): void => {
    let rest = piece
    // A chunk that ends inside a fence gets "```\n" appended by `flush`, so that
    // space belongs to the budget or the chunk overshoots the limit.
    // Always reserve room for a closing fence: whether one is appended depends
    // on the fence state at flush time, which can differ from the state when
    // the text was appended.
    const closer = (): number => 4
    while (rest.length > 0) {
      const head = current === "" ? "" : "\n"
      const room = budget - current.length - head.length - closer()
      if (room > 0 && rest.length <= room) {
        current += head + rest
        return
      }
      // The buffer cannot take the piece, or is already full: close it and try
      // again — but `flush` reopens a fence as "```", which is not progress, so
      // flushing a fence-only buffer would loop forever. Only flush real
      // content, and never when the buffer holds nothing but that marker.
      const fenceOnly = fence && current === "```"
      if (current !== "" && !fenceOnly) {
        flush()
        continue
      }
      // Longer than a whole chunk (or nothing left to flush): cut it, preferring
      // a break near the cut so words survive.
      const slice = rest.slice(0, Math.max(room, 1))
      const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("，"), slice.lastIndexOf("、"))
      const take = breakAt > slice.length * 0.6 ? breakAt + 1 : Math.max(room, 1)
      current += head + rest.slice(0, take)
      flush()
      rest = rest.slice(take)
    }
  }

  for (const line of normalized.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence
    push(line)
  }
  flush()
  return chunks
}

/**
 * Number the parts of a multi-part reply: `（2/5）`.
 *
 * WeChat cannot edit a message, so a user who sees part 3 of 5 knows a part is
 * missing — without this, a half-delivered answer just looks like the model
 * stopped mid-sentence.
 */
export function numberChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  return chunks.map((chunk, index) => `（${index + 1}/${chunks.length}）\n${chunk}`)
}

export function conversationIdOf(message: InboundMessage): string {
  return message.conversationId || conversationKey(message.accountId, message.peerId, message.groupId)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when a maintenance tick arrived so late that the process was suspended. */
export function isResumeGap(previousTick: number, now: number): boolean {
  return previousTick > 0 && now - previousTick > SUSPENSION_GAP_MS
}

/**
 * Whether a stale-token report may clear the stored credential.
 *
 * A re-login can land between the server's rejection and this handler, and
 * wiping the fresh token would cost the user another QR scan for a channel that
 * was already fixed — so only the credential the poller actually used may go.
 */
export function shouldClearStaleToken(current: string | undefined, rejectedToken: string | undefined): boolean {
  if (rejectedToken === undefined) return true
  return current === rejectedToken
}
