/**
 * User settings for the WeChat bridge.
 *
 * Stored next to the state file so the plugin works when it is auto-discovered
 * from `~/.config/opencode/plugins/` (auto-discovered plugins cannot receive
 * `options` from `opencode.jsonc`). The file is re-read on every ownership tick,
 * so editing it — or running `/wechat-config` in another OpenCode window — takes
 * effect within a few seconds without a restart.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { writePrivate, ensureStateDir, STATE_DIR } from "./state.ts"

export const CONFIG_PATH = join(STATE_DIR, "config.json")

export interface WechatConfig {
  /** Default working directory for sessions created from WeChat. */
  directory: string
  /** Send a one-line note per tool call while the agent works. */
  progress: "off" | "tools"
  /** Also push results of sessions that were not started from WeChat. */
  mirrorAll: boolean
  /** WeChat truncates long messages; replies are split into chunks of this size. */
  chunkSize: number
  /** How many sessions `/list` shows. */
  listLimit: number
  /**
   * `live` pushes the assistant's text while a turn is still running, every
   * `streamIntervalMs`; `off` waits for the turn to finish. WeChat cannot edit
   * a message, so live mode is a burst of messages — useful for long tasks on a
   * phone, noisy for quick ones.
   */
  stream: "off" | "live"
  streamIntervalMs: number
  /**
   * How long a finished text block waits for the session's "idle" signal
   * before it is sent anyway, in milliseconds.
   *
   * The idle event turned out to be unreliable on v2 (answers were measured
   * going out exactly this long after the text stopped, i.e. this timer was
   * doing the delivering), so this is effectively the reply latency: keep it
   * short. `0` sends each finished block as soon as it ends.
   */
  turnGraceMs: number
  /** Rename the session after the first message so the phone shows something meaningful. */
  autoTitle: boolean
  /** Delay between outbound chunks: bursts are more likely to be refused. */
  sendDelayMs: number
  /** Send an immediate "working on it" line so a slow turn does not feel dead. */
  ack: "off" | "text"
  /**
   * WeChat user ids allowed to drive the bot. Empty means the account's bound
   * user only, which is what QR-code login already guarantees.
   */
  allowedUsers: string[]
  /** Agent for new sessions. Empty uses the project default. */
  agent: string
  /** Model for new sessions, as `providerID/modelID`. Empty uses the default. */
  model: string
  /** How long `wechat_ask` waits for an answer before giving up. */
  askTimeoutMs: number
  /**
   * How long to wait for a burst of approval requests before announcing them.
   *
   * An agent that needs three things approved asks three times in a row; one
   * message listing all three is much easier to answer on a phone.
   */
  approvalBurstMs: number
  /**
   * Follow the session the desktop is working in.
   *
   * When on, the conversation re-binds itself to the most recently active
   * session, so WeChat keeps talking to whatever you are doing on the computer.
   * An explicit `/switch` suspends following for `followHoldMs`.
   */
  followActive: boolean
  /** How long a manual `/switch` wins over auto-follow. */
  followHoldMs: number
  /** Only follow sessions touched within this window, so we never jump to something stale. */
  followWindowMs: number
  /**
   * Retry delays for a refused (queued) message, in milliseconds.
   *
   * Once these run out the queue is parked until the next inbound message —
   * which is the one moment the reply window is guaranteed to be open again.
   */
  retryBackoffMs: number[]
}

export const DEFAULT_CONFIG: WechatConfig = {
  directory: homedir(),
  progress: "tools",
  mirrorAll: false,
  chunkSize: 3_900,
  listLimit: 15,
  stream: "off",
  streamIntervalMs: 8_000,
  turnGraceMs: 3_000,
  autoTitle: true,
  sendDelayMs: 250,
  ack: "off",
  allowedUsers: [],
  agent: "",
  model: "",
  askTimeoutMs: 10 * 60_000,
  approvalBurstMs: 800,
  followActive: false,
  followHoldMs: 5 * 60_000,
  followWindowMs: 10 * 60_000,
  retryBackoffMs: [5_000, 15_000, 45_000, 120_000, 300_000],
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function pickNumber(value: unknown, fallback: number, minimum = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : fallback
}

export function normalizeConfig(input: Partial<WechatConfig> | undefined): WechatConfig {
  const raw = input ?? {}
  return {
    directory: pickString(raw.directory, DEFAULT_CONFIG.directory),
    progress: raw.progress === "off" ? "off" : "tools",
    mirrorAll: raw.mirrorAll === true,
    chunkSize: pickNumber(raw.chunkSize, DEFAULT_CONFIG.chunkSize, 200),
    listLimit: pickNumber(raw.listLimit, DEFAULT_CONFIG.listLimit, 1),
    stream: raw.stream === "live" ? "live" : "off",
    streamIntervalMs: pickNumber(raw.streamIntervalMs, DEFAULT_CONFIG.streamIntervalMs, 1_000),
    turnGraceMs: pickNumber(raw.turnGraceMs, DEFAULT_CONFIG.turnGraceMs, 0),
    autoTitle: raw.autoTitle !== false,
    sendDelayMs: pickNumber(raw.sendDelayMs, DEFAULT_CONFIG.sendDelayMs, 0),
    ack: raw.ack === "text" ? "text" : "off",
    allowedUsers: Array.isArray(raw.allowedUsers)
      ? raw.allowedUsers.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : [],
    agent: typeof raw.agent === "string" ? raw.agent.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    askTimeoutMs: pickNumber(raw.askTimeoutMs, DEFAULT_CONFIG.askTimeoutMs, 5_000),
    approvalBurstMs: pickNumber(raw.approvalBurstMs, DEFAULT_CONFIG.approvalBurstMs, 0),
    followActive: raw.followActive === true,
    followHoldMs: pickNumber(raw.followHoldMs, DEFAULT_CONFIG.followHoldMs, 0),
    followWindowMs: pickNumber(raw.followWindowMs, DEFAULT_CONFIG.followWindowMs, 0),
    retryBackoffMs:
      Array.isArray(raw.retryBackoffMs) && raw.retryBackoffMs.every((value) => typeof value === "number" && value >= 0)
        ? raw.retryBackoffMs
        : [...DEFAULT_CONFIG.retryBackoffMs],
  }
}

export function readConfig(): WechatConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG }
    return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<WechatConfig>)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function writeConfig(config: WechatConfig): void {
  ensureStateDir()
  writePrivate(CONFIG_PATH, JSON.stringify(normalizeConfig(config), null, 2))
}

/** True when the config file changed since `previous` (cheap structural check). */
export function configChanged(previous: WechatConfig, next: WechatConfig): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next)
}
