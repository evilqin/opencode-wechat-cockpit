/**
 * One account's inbound pump.
 *
 * The loop mirrors Tencent's own monitor:
 *  - one long poll at a time, with the client budget slightly above the
 *    server's suggestion so the server always wins the race;
 *  - the cursor is persisted *before* the batch is dispatched, so a crash
 *    mid-handling replays instead of dropping messages;
 *  - `errcode -14` pauses the account for an hour rather than hammering an
 *    endpoint that cannot succeed until the user re-binds;
 *  - other failures retry, then back off.
 */

import {
  apiCall,
  baseInfo,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  MessageType,
  STALE_TOKEN_ERRCODE,
  SESSION_PAUSE_MS,
  RETRY_DELAY_MS,
  BACKOFF_DELAY_MS,
  MAX_CONSECUTIVE_FAILURES,
  sleep,
  type GetUpdatesResp,
  type MessageItem,
  type WeixinAccount,
  type WeixinMessage,
  isMediaItem,
} from "./ilink.ts"

/** A message ready to be handed to the bridge. */
export interface InboundMessage {
  accountId: string
  /** Counterparty: the WeChat user id. */
  peerId: string
  groupId?: string
  /** Stable conversation key across restarts. */
  conversationId: string
  messageId?: string
  /** Required verbatim on the reply to keep the reply window open. */
  contextToken?: string
  text: string
  /** Attachments the message carried, in wire order. */
  media?: MessageItem[]
  /**
   * The untouched wire message.
   *
   * Optional because it is only needed by features that read fields the bridge
   * does not model (quoted messages, for instance); tests construct inbound
   * envelopes without it.
   */
  raw?: WeixinMessage
  receivedAt: number
}

export type MonitorStopReason = "stale-token" | "aborted"

export interface MonitorOptions {
  account: WeixinAccount
  onMessage: (message: InboundMessage) => Promise<void>
  initialSyncBuf?: string
  onSyncBuf?: (buf: string) => Promise<void> | void
  onError?: (error: unknown) => void
  onStop?: (reason: MonitorStopReason, detail?: string) => void
  /**
   * Checked once per poll cycle and before each batch is dispatched.
   *
   * Belt and braces for the single-poller rule: even if an owner is never
   * unloaded and its abort signal is lost, a loop that no longer owns the lock
   * stops by itself instead of delivering every message a second time.
   */
  shouldContinue?: () => boolean
}

export class ChannelMonitor {
  readonly #options: MonitorOptions
  #syncBuf: string
  #longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS
  #consecutiveFailures = 0
  #pausedUntil = 0
  /** When the last long poll came back, for the poller watchdog. */
  #lastActivityAt = Date.now()

  constructor(options: MonitorOptions) {
    this.#options = options
    this.#syncBuf = options.initialSyncBuf ?? ""
  }

  /**
   * When this loop last completed a long poll.
   *
   * A held request that never returns leaves the loop alive and silent: no
   * messages, no errors, nothing in the log. The bridge watches this timestamp
   * and rebuilds the monitor when it goes stale, which is the only way to
   * recover from a socket that stopped responding without erroring.
   */
  get lastActivityAt(): number {
    return this.#lastActivityAt
  }

  get syncBuf(): string {
    return this.#syncBuf
  }

  get paused(): boolean {
    return Date.now() < this.#pausedUntil
  }

  get remainingPauseMs(): number {
    return Math.max(0, this.#pausedUntil - Date.now())
  }

  /** Run until aborted or the token goes stale. */
  async run(signal: AbortSignal): Promise<MonitorStopReason> {
    const { account } = this.#options

    while (!signal.aborted) {
      if (!this.#stillOwned()) {
        this.#options.onStop?.("aborted", "不再持有轮询锁，自行退出")
        return "aborted"
      }
      if (this.paused) {
        await sleep(this.remainingPauseMs, signal)
        continue
      }

      let response: GetUpdatesResp
      try {
        response = await this.#getUpdates(account, signal)
      } catch (error) {
        if (signal.aborted) break
        this.#options.onError?.(error)
        this.#consecutiveFailures += 1
        await sleep(this.#failureDelay(), signal)
        continue
      }

      if (typeof response.longpolling_timeout_ms === "number" && response.longpolling_timeout_ms > 0) {
        this.#longPollTimeoutMs = response.longpolling_timeout_ms
      }
      this.#lastActivityAt = Date.now()

      const code = response.errcode ?? response.ret
      if (code !== undefined && code !== 0) {
        if (code === STALE_TOKEN_ERRCODE) {
          this.#pausedUntil = Date.now() + SESSION_PAUSE_MS
          this.#options.onStop?.("stale-token", "bot token 已失效，需要重新扫码绑定")
          return "stale-token"
        }
        this.#consecutiveFailures += 1
        this.#options.onError?.(
          new Error(`getupdates 失败 ret=${response.ret} errcode=${response.errcode} errmsg=${response.errmsg ?? ""}`),
        )
        await sleep(this.#failureDelay(), signal)
        continue
      }

      this.#consecutiveFailures = 0

      // Ownership may have changed while the request was held; a batch handled
      // by a poller that no longer owns the slot would be handled twice.
      if (!this.#stillOwned()) {
        this.#options.onStop?.("aborted", "不再持有轮询锁，放弃本批消息")
        return "aborted"
      }

      // Persist the cursor before dispatch: a crash while handling replays the batch.
      if (response.get_updates_buf) {
        this.#syncBuf = response.get_updates_buf
        await this.#options.onSyncBuf?.(this.#syncBuf)
      }

      for (const raw of response.msgs ?? []) {
        const inbound = toInbound(account, raw)
        if (!inbound) continue
        try {
          await this.#options.onMessage(inbound)
        } catch (error) {
          // One bad message must not kill the pump.
          this.#options.onError?.(error)
        }
      }
    }

    this.#options.onStop?.("aborted")
    return "aborted"
  }

  async #getUpdates(account: WeixinAccount, signal: AbortSignal): Promise<GetUpdatesResp> {
    // Client budget exceeds the server's suggestion so the server returns first.
    const timeoutMs = this.#longPollTimeoutMs + 5_000
    try {
      return await apiCall<GetUpdatesResp>({
        baseUrl: account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        body: { get_updates_buf: this.#syncBuf, base_info: baseInfo() },
        token: account.token,
        timeoutMs,
        signal,
      })
    } catch (error) {
      // A held request we stopped waiting on is a normal empty tick.
      if (error instanceof Error && error.name === "AbortError" && !signal.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: this.#syncBuf }
      }
      throw error
    }
  }

  #failureDelay(): number {
    return this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS
  }

  #stillOwned(): boolean {
    return this.#options.shouldContinue?.() ?? true
  }
}

export function conversationKey(accountId: string, peerId: string, groupId?: string): string {
  return groupId ? `${accountId}:${groupId}:${peerId}` : `${accountId}:${peerId}`
}

/**
 * Convert a wire message into an inbound envelope.
 *
 * Returns `undefined` for messages the bot itself sent (`message_type` 2),
 * which would otherwise loop back into the agent.
 */
export function toInbound(account: WeixinAccount, raw: WeixinMessage): InboundMessage | undefined {
  if (raw.message_type === MessageType.BOT) return undefined
  const peerId = raw.from_user_id?.trim()
  if (!peerId) return undefined

  const text = extractItemsText(raw)
  const media = (raw.item_list ?? []).filter((item) => isMediaItem(item))
  if (!text && media.length === 0) return undefined

  return {
    accountId: account.accountId,
    peerId,
    ...(raw.group_id ? { groupId: raw.group_id } : {}),
    conversationId: conversationKey(account.accountId, peerId, raw.group_id || undefined),
    ...(raw.message_id === undefined ? {} : { messageId: raw.message_id }),
    ...(raw.context_token === undefined ? {} : { contextToken: raw.context_token }),
    text,
    ...(media.length === 0 ? {} : { media }),
    raw,
    receivedAt: Date.now(),
  }
}

function extractItemsText(message: WeixinMessage): string {
  const parts: string[] = []
  for (const item of message.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text)
    else if (item.type === 3 && item.voice_item?.text) parts.push(item.voice_item.text)
  }
  return parts.join("\n").trim()
}
