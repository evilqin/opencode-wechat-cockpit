/**
 * One account's inbound pump.
 *
 * The loop mirrors Tencent's own monitor:
 *  - one long poll at a time, with the client budget slightly above the
 *    server's suggestion so the server always wins the race;
 *  - the cursor is persisted *before* the batch is dispatched, so a crash
 *    mid-handling replays instead of dropping messages;
 *  - `errcode -14` stops the pump and reports a stale token, which is the only
 *    thing the user can act on (a fresh QR scan);
 *  - other failures retry, then back off.
 */

import {
  apiCall,
  baseInfo,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  ItemType,
  MessageType,
  STALE_TOKEN_ERRCODE,
  RETRY_DELAY_MS,
  BACKOFF_DELAY_MS,
  MAX_CONSECUTIVE_FAILURES,
  sleep,
  type GetUpdatesResp,
  type MessageItem,
  type WeixinAccount,
  type WeixinMessage,
  isMediaItem,
  toCode,
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

/**
 * Clamp the server's long-poll timeout suggestion.
 *
 * The value arrives in a poll answer, i.e. from the network: one claiming a day
 * would hold the loop until the stall watchdog fires, and one claiming a
 * millisecond would spin.
 */
export function clampPollTimeout(ms: number): number {
  return Math.min(Math.max(ms, 5_000), 90_000)
}

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
  /**
   * Called when a poll ended by client-side timeout instead of an answer.
   *
   * A healthy long poll is always answered — the server's own timeout is
   * shorter than the client's budget — so a timeout means the request was sent
   * and nothing came back. That is what a logged-out portal, a stale NAT entry
   * or a Wi-Fi link that only looks connected leaves behind, and it is
   * invisible otherwise: the loop keeps cycling, nothing is logged, and the
   * channel simply goes quiet.
   */
  onTimeout?: (consecutive: number) => void
  /** Called when a real answer arrives after one or more timeouts. */
  onRecovered?: (timeouts: number) => void
  /** Initial long-poll budget; a server suggestion replaces it. Tests use this. */
  initialTimeoutMs?: number
  /** How long the client waits past the server's suggestion. Tests use this. */
  timeoutGraceMs?: number
}

export class ChannelMonitor {
  readonly #options: MonitorOptions
  #syncBuf: string
  #longPollTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS
  #consecutiveFailures = 0
  /** When the last long poll came back, for the poller watchdog. */
  #lastActivityAt = Date.now()
  /** Consecutive polls that ended by client-side timeout. */
  #consecutiveTimeouts = 0
  /** When a real answer last arrived; timeouts deliberately do not update it. */
  #lastResponseAt = Date.now()

  constructor(options: MonitorOptions) {
    this.#options = options
    this.#syncBuf = options.initialSyncBuf ?? ""
    if (options.initialTimeoutMs) this.#longPollTimeoutMs = options.initialTimeoutMs
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

  /**
   * Consecutive polls that never got an answer.
   *
   * Non-zero means the path is dropping traffic: the requests leave, nothing
   * comes back, and only the client budget ends the cycle.
   */
  get consecutiveTimeouts(): number {
    return this.#consecutiveTimeouts
  }

  /** When the last poll was answered by the server. */
  get lastResponseAt(): number {
    return this.#lastResponseAt
  }

  get syncBuf(): string {
    return this.#syncBuf
  }

  /** Run until aborted or the token goes stale. */
  async run(signal: AbortSignal): Promise<MonitorStopReason> {
    const { account } = this.#options

    while (!signal.aborted) {
      if (!this.#stillOwned()) {
        this.#options.onStop?.("aborted", "不再持有轮询锁，自行退出")
        return "aborted"
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

      // A well-formed response is an object; a null/scalar body (a proxy or a
      // captive portal answering with garbage) must not throw a TypeError out
      // of the loop, or the poller silently dies.
      if (typeof response !== "object" || response === null) {
        this.#consecutiveFailures += 1
        this.#options.onError?.(new Error("getupdates 返回的不是对象，已按协议错误处理"))
        await sleep(this.#failureDelay(), signal)
        continue
      }

      const suggested = response.longpolling_timeout_ms
      if (typeof suggested === "number" && suggested > 0) {
        this.#longPollTimeoutMs = clampPollTimeout(suggested)
      }
      this.#lastActivityAt = Date.now()

      const code = toCode(response.errcode ?? response.ret)
      if (code !== undefined && code !== 0) {
        if (code === STALE_TOKEN_ERRCODE) {
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

      // A type-confused answer (portal, middlebox) must not throw out of the
      // loop: that crash-loop would restart the poller forever and drop the
      // batch's cursor with it.
      if (response.msgs !== undefined && !Array.isArray(response.msgs)) {
        this.#consecutiveFailures += 1
        this.#options.onError?.(
          new Error(`getupdates 的 msgs 不是数组（${typeof response.msgs}），已按协议错误处理`),
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
      // `batchStartBuf` is kept so an abort or a failing message can put it back —
      // otherwise the next owner starts *after* messages nobody ever saw.
      const batchStartBuf = this.#syncBuf
      if (response.get_updates_buf) {
        this.#syncBuf = response.get_updates_buf
        try {
          await this.#options.onSyncBuf?.(this.#syncBuf)
        } catch (error) {
          // A failed cursor write must not kill the pump: the next poll retries.
          this.#options.onError?.(error)
        }
      }

      const rewind = async (detail: string): Promise<void> => {
        // Without a batch-start cursor there is nothing to rewind to; the
        // in-memory cursor then stays as it is (the next owner gets the same
        // replay guarantee from its own start position).
        if (batchStartBuf === undefined || this.#syncBuf === batchStartBuf) return
        this.#syncBuf = batchStartBuf
        try {
          await this.#options.onSyncBuf?.(batchStartBuf)
        } catch (error) {
          this.#options.onError?.(error)
        }
        this.#options.onError?.(
          new Error(`${detail}；游标已回退到本批开头，这批消息会在下次轮询重放（去重窗口吸收重复）`),
        )
      }

      for (const raw of response.msgs ?? []) {
        // Ownership can change mid-batch (a handover, a hot reload). A disowned
        // poller must stop dispatching, or the rest of the batch is handled
        // twice — the exact race the pre-batch check exists to prevent.
        if (!this.#stillOwned()) {
          await rewind("不再持有轮询锁，放弃本批剩余消息")
          this.#options.onStop?.("aborted", "不再持有轮询锁，放弃本批剩余消息")
          return "aborted"
        }
        const inbound = toInbound(account, raw)
        if (!inbound) continue
        try {
          await this.#options.onMessage(inbound)
        } catch (error) {
          // One bad message must not kill the pump — but it must not be skipped
          // either: rewind so the batch is redelivered and this message retried.
          this.#options.onError?.(error)
          await rewind("处理消息失败")
          break
        }
      }
    }

    this.#options.onStop?.("aborted")
    return "aborted"
  }

  async #getUpdates(account: WeixinAccount, signal: AbortSignal): Promise<GetUpdatesResp> {
    // Client budget exceeds the server's suggestion so the server returns first.
    const timeoutMs = this.#longPollTimeoutMs + (this.#options.timeoutGraceMs ?? 5_000)
    try {
      const response = await apiCall<GetUpdatesResp>({
        baseUrl: account.baseUrl,
        endpoint: "ilink/bot/getupdates",
        body: { get_updates_buf: this.#syncBuf, base_info: baseInfo() },
        token: account.token,
        timeoutMs,
        signal,
      })
      return this.#markResponded(response)
    } catch (error) {
      // Our own budget ran out: the request was sent and nothing answered.
      if (error instanceof Error && error.name === "AbortError" && !signal.aborted) {
        this.#consecutiveTimeouts += 1
        this.#options.onTimeout?.(this.#consecutiveTimeouts)
        return { ret: 0, msgs: [], get_updates_buf: this.#syncBuf }
      }
      throw error
    }
  }

  /** Record a real answer and report the end of a timeout streak. */
  #markResponded(response: GetUpdatesResp): GetUpdatesResp {
    this.#lastResponseAt = Date.now()
    if (this.#consecutiveTimeouts > 0) {
      const timeouts = this.#consecutiveTimeouts
      this.#consecutiveTimeouts = 0
      this.#options.onRecovered?.(timeouts)
    }
    return response
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
  // Direct messages only: the ClawBot protocol declares no group support, and
  // answering into a group would bind a group conversation the bridge does not
  // model (the README promises groups are ignored, so this enforces it).
  if (raw.group_id) return undefined
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
    if (item.type === ItemType.TEXT && item.text_item?.text) parts.push(item.text_item.text)
    else if (item.type === ItemType.VOICE && item.voice_item?.text) parts.push(item.voice_item.text)
  }
  return parts.join("\n").trim()
}
