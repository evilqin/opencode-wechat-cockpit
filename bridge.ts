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
import { pathToFileURL } from "node:url"
import { promises as fs, readFileSync } from "node:fs"

import type * as OpenCodePlugin from "@opencode/plugin"

/** The plugin context type, taken from the host's own definition. */
type Context = OpenCodePlugin.Plugin.Context

import { LocalApi, type ApiSession, type ApiForm } from "./api.ts"
import { HELP_TEXT, renderCommandDoc, renderManual, resolveCommandDoc } from "./manual.ts"
import {
  SendRefusedError,
  notifyStart,
  notifyStop,
  sendItems,
  sendText,
  getTypingTicket,
  sendTyping,
  textItem,
  type WeixinAccount,
} from "./ilink.ts"
import { ChannelMonitor, conversationKey, type InboundMessage } from "./monitor.ts"
import { downloadItem, prepareAttachment, kindForPath, type OutboundKind } from "./media.ts"
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
  readState,
  updateState,
  STATE_DIR,
  SEEN_MESSAGE_LIMIT,
  type LockHandle,
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
  /** Set when a streamed fragment could not be delivered. */
  degraded?: boolean
  timer?: NodeJS.Timeout
}

/** A question the agent asked and is blocked on. */
interface PendingQuestion {
  conversationId: string
  resolve: (answer: string) => void
  timer: NodeJS.Timeout
}

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
  #pendingPermissions: PendingPermission[] = []
  #pendingForms: PendingForm[] = []
  #pendingQuestions = new Map<string, PendingQuestion>()
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
  /** When the poller was last rebuilt because polls stopped being answered. */
  #lastPollRestart = 0
  /** Previous ownership tick, to notice that the process was suspended. */
  #lastTickAt = 0
  /** When the queue last delivered something, so `/more` can avoid duplicating it. */
  #lastFlushedAt = new Map<string, number>()

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

    if (this.#lock.info.instanceId !== lockOwnerInstanceId()) {
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
      if (this.#lock && this.#lock.info.instanceId !== lockOwnerInstanceId()) {
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
      // working owner from a wedged one.
      if (this.#monitor) this.#lock?.touchPolledAt(this.#monitor.lastActivityAt)
      if (this.#monitor && Date.now() - this.#monitor.lastActivityAt > POLL_STALL_MS) {
        this.#log.warn(
          `poller looks stuck (no activity for ${Math.round((Date.now() - this.#monitor.lastActivityAt) / 1000)}s); restarting it`,
        )
        this.stopPolling({ restart: true })
        this.startPolling()
      }
      // Anything the agent is waiting on while this instance restarted must be
      // picked back up, or the question would sit unanswered on the server.
      if (Date.now() - this.#lastReconcile > RECONCILE_INTERVAL_MS) {
        void this.reconcilePending().catch((error) => this.#log.warn(`reconcile failed: ${errorText(error)}`))
      }
      // Keep the conversation on whatever the desktop is working on.
      void this.followActiveSession().catch((error) => this.#log.warn(`auto-follow failed: ${errorText(error)}`))
    } catch (error) {
      this.#log.warn(`ownership check failed: ${errorText(error)}`)
    }
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
    if (this.#monitor) return
    if (!this.#lock || this.#lock.info.instanceId !== lockOwnerInstanceId()) return
    if (!this.#state.account?.token) return

    const account = this.#state.account
    const controller = new AbortController()
    this.#stopMonitor = () => controller.abort()

    const monitor = new ChannelMonitor({
      account,
      initialSyncBuf: this.#state.syncBuf,
      onSyncBuf: (buf) => {
        this.#state = updateState((state) => {
          state.syncBuf = buf
        })
      },
      onMessage: (message) => this.handleInbound(message),
      onError: (error) => this.#log.warn(`poll: ${errorText(error)}`),
      onTimeout: (consecutive) => this.#handlePollTimeout(consecutive),
      onRecovered: (timeouts) => this.#log.info(`poll answers resumed after ${timeouts} timeout(s)`),
      shouldContinue: () => this.ownsPoller,
      onStop: (reason, detail) => {
        this.#log.warn(`poll stopped: ${reason}${detail ? ` (${detail})` : ""}`)
        if (reason === "stale-token") this.#handleStaleToken()
      },
    })

    this.#monitor = monitor
    this.#log.info(`poller started for ${account.accountId} via ${account.baseUrl}`)
    void notifyStart(account).catch((error) => this.#log.warn(`notifystart failed: ${errorText(error)}`))
    void monitor
      .run(controller.signal)
      .then((reason) => this.#log.info(`poller exited: ${reason}`))
      .catch((error) => this.#log.warn(`poller crashed: ${errorText(error)}`))
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

  stopPolling(options: { restart?: boolean } = {}): void {
    this.#stopMonitor?.()
    this.#stopMonitor = undefined
    this.#monitor = undefined
    if (options.restart) return

    for (const timer of this.#typingTimers.values()) clearInterval(timer)
    this.#typingTimers.clear()
    this.#typingSessions.clear()
    for (const timer of this.#retryTimers.values()) clearTimeout(timer)
    this.#retryTimers.clear()
    for (const turn of this.#turns.values()) if (turn.timer) clearTimeout(turn.timer)
    this.#turns.clear()
    for (const live of this.#live.values()) if (live.timer) clearTimeout(live.timer)
    this.#live.clear()
    for (const question of this.#pendingQuestions.values()) {
      clearTimeout(question.timer)
      question.resolve("通道已停止（轮询器退出），这个问题没有等到回答。")
    }
    this.#pendingQuestions.clear()
  }

  /** The token was rejected: stop, and say what to do about it. */
  #handleStaleToken(): void {
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
        notes.push(`[收到附件 ${result.media.name}（${result.media.bytes} 字节），已保存为本地文件]`)
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

    if (await this.#maybeHandlePermissionReply(conversationId, text)) return
    if (text.startsWith("/") && (await this.#handleCommand(conversationId, text))) return

    // A question from `wechat_ask` consumes the next ordinary message: the agent
    // is blocked on it, so anything else would be answered out of order.
    const question = this.#pendingQuestions.get(conversationId)
    if (question) {
      this.#pendingQuestions.delete(conversationId)
      clearTimeout(question.timer)
      this.#log.info(`question answered: ${text.slice(0, 80)}`)
      question.resolve(text)
      return
    }

    await this.#dispatch(conversationId, text, attachments, titleHint)
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
    if (this.#pendingQuestions.has(conversationId)) {
      return "已经有一个问题在等用户回答了，请先等它返回。"
    }

    this.#state = updateState((state) => {
      state.lastConversation = conversationId
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
      return "微信消息没有发出去（通道未登录，或回复窗口关闭后正在重试）。请改用普通回复说明情况。"
    }

    return await new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingQuestions.delete(conversationId)
        resolve(`用户在 ${Math.round(timeoutMs / 60_000)} 分钟内没有回答。`)
      }, timeoutMs)
      timer.unref?.()
      this.#pendingQuestions.set(conversationId, { conversationId, resolve, timer })
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
      const bound = this.#state.account?.userId
      return !bound || bound === peerId
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
    const [rawCommand, ...rest] = text.split(/\s+/)
    const command = rawCommand.toLowerCase().replace(/[:：]$/, "")
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
      const candidate = isAbsolute(argument) ? argument : resolvePath(argument)
      const stats = await fs.stat(candidate).catch(() => undefined)
      if (stats?.isDirectory()) {
        directory = candidate
        title = basename(candidate)
      } else {
        title = argument
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
    const raw = argument.trim()
    const wantOthers = /^all\b/i.test(raw)
    const requested = Number.parseInt(raw.replace(/^all\b/i, "").trim(), 10)
    const page = Number.isFinite(requested) && requested > 0 ? requested : 1
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
    const { sessions } = await this.#collectSessions()
    const conversationId = this.#state.lastConversation ?? ""
    const remembered = this.#lastListing.get(conversationId)
    const index = Number.parseInt(argument, 10)
    if (Number.isFinite(index) && String(index) === argument.trim() && remembered) {
      const id = remembered[index - 1]
      const found = id ? sessions.find((session) => session.id === id) : undefined
      if (found) return found
    }
    return resolveSessionTarget(sessions, argument)
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
      const target = await this.#resolveIndexed(argument)
      if (!target) {
        await this.#send(conversationId, `没找到匹配的会话：${argument}`)
        return
      }
      // Same path as the desktop button, so both surfaces record the same thing.
      await this.lendSession(target.id)
      return
    }

    const target = await this.#pickActiveSession()
    if (!target) {
      await this.#send(conversationId, "本地 API 不可用或没有会话可跟随。用 /list 手动挑一个。")
      return
    }

    const running = (await this.#api.listActiveSessions()).includes(target.id)
    this.#bind(conversationId, target, { explicit: true })
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
    // Leaving a session also clears its phone marker.
    if (binding?.sessionID) await this.#markPhoneUsage(binding.sessionID, false)
    this.#bind(conversationId, { id: channel.id, title: channel.title, location: channel.location })
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
    if (argument === "clear") {
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
        ...queued.slice(0, 5).map((text, index) => `${index + 1}. ${text.replace(/\s+/g, " ").slice(0, 80)}`),
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
      await this.#ctx.session.update({ sessionID: binding.sessionID, title: argument })
      this.#state = updateState((state) => {
        const current = state.bindings[conversationId]
        if (current) state.bindings[conversationId] = { ...current, title: argument }
      })
      await this.#send(conversationId, `✅ 已重命名为「${argument}」`)
    } catch (error) {
      await this.#send(conversationId, `❌ 重命名失败：${errorText(error)}`)
    }
  }

  async #cancel(conversationId: string, argument: string): Promise<void> {
    const binding = this.#state.bindings[conversationId]
    if (!binding) {
      await this.#send(conversationId, "当前没有会话。")
      return
    }
    try {
      await this.#ctx.session.interrupt({ sessionID: binding.sessionID })
      const dropped = argument === "all" ? this.#dropQueue(conversationId) : 0
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
    const candidate = isAbsolute(argument) ? argument : resolvePath(argument)
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
    this.#pendingPermissions.push(request)
    while (this.#pendingPermissions.length > MAX_PENDING_PERMISSIONS) this.#pendingPermissions.shift()

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
      if (requests.length === 1) {
        const request = requests[0]
        await this.#send(
          conversationId,
          formatPermissionPrompt(request, 1, 1, binding?.title),
        )
        continue
      }
      await this.#send(conversationId, formatPermissionBatch(requests, binding?.title))
    }
  }

  /*
   * -------------------------------------------------------------------------
   * Forms (the agent's interactive questions)
   * -------------------------------------------------------------------------
   */

  async #answerForm(conversationId: string, argument: string): Promise<void> {
    const pending = this.#pendingForms.filter((item) => item.conversationId === conversationId)
    if (pending.length === 0) {
      await this.#send(conversationId, "当前没有待回答的问题。")
      return
    }

    const form = pending[0]
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

      case "session.idle": {
        if (sessionID) await this.#finishTurn(sessionID, "idle")
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
    entry.timer = setTimeout(() => void this.#finishTurn(sessionID, "timer"), this.#config.turnGraceMs)
    entry.timer.unref?.()
    this.#turns.set(sessionID, entry)
  }

  /** A turn ended: deliver whatever is left and stop the "typing" indicator. */
  async #finishTurn(sessionID: string, trigger: "idle" | "timer" | "failed" = "idle"): Promise<void> {
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
        void this.#flushLive(sessionID)
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
    // Streaming fragments are not queued: a stale fragment arriving minutes
    // later is worse than a gap, and the assembled turn covers the gap.
    const refused = await this.#trySend(entry.conversationId, text)
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
      const refused = await this.#trySend(conversationId, chunk)
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

    const hadQueue = this.#queueFor(conversationId).length > 0
    let delivered = true
    let failedFrom = -1
    for (const [index, chunk] of chunks.entries()) {
      const ok = await this.sendChunk(conversationId, chunk)
      if (ok) continue
      delivered = false
      if (failedFrom < 0) failedFrom = index
    }

    if (failedFrom >= 0 && !hadQueue) {
      // The tail is queued; say so in front of it, otherwise a half-delivered
      // answer looks like the model stopped on its own and the user has no way
      // to know that simply speaking will fetch the rest.
      const waiting = chunks.length - failedFrom
      this.#prependToQueue(
        conversationId,
        `⚠️ 上面那条没发完（还有 ${waiting} 段）。发一句话或 /more 我就把剩下的补上。`,
      )
    }
    return delivered
  }

  /** Put a line at the head of a conversation's queue. */
  #prependToQueue(conversationId: string, text: string): void {
    const queue = this.#queueFor(conversationId)
    this.#setQueue(conversationId, [text, ...queue].slice(-20))
  }

  /** Send to the most recently active conversation. Used by the tools. */
  async sendToLast(text: string): Promise<boolean> {
    this.reloadState()
    const conversationId = this.#state.lastConversation
    if (!conversationId) return false
    for (const chunk of chunkText(text, this.#config.chunkSize)) {
      const ok = await this.sendChunk(conversationId, chunk, true)
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
  async #trySend(conversationId: string, chunk: string): Promise<SendRefusedError | undefined> {
    if (!this.#state.account?.token) this.reloadState()
    const account = this.#state.account
    if (!account?.token) return new SendRefusedError("微信通道尚未登录", LOCAL_FAILURE)

    const peerId = conversationId.split(":").pop()
    if (!peerId) return new SendRefusedError("会话标识无效", LOCAL_FAILURE)

    const contextToken = this.#state.contextTokens[conversationId]
    try {
      await sendText({ account, to: peerId, text: chunk, contextToken })
      this.#log.info(`sent ${chunk.length} chars to ${peerId.slice(0, 12)}…: ${preview(chunk)}`)
      return undefined
    } catch (error) {
      if (!(error instanceof SendRefusedError)) {
        this.#log.warn(`send failed: ${errorText(error)}`)
        return new SendRefusedError(`发送失败：${errorText(error)}`, LOCAL_FAILURE)
      }
      if (contextToken) {
        try {
          await sendText({ account, to: peerId, text: chunk })
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
    const previous = this.#sendChains.get(conversationId) ?? Promise.resolve()
    const next = previous.then(
      () => this.#sendChunkNow(conversationId, chunk, throwOnFailure),
      () => this.#sendChunkNow(conversationId, chunk, throwOnFailure),
    )
    this.#sendChains.set(
      conversationId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  async #sendChunkNow(conversationId: string, chunk: string, throwOnFailure: boolean): Promise<boolean> {
    const refused = await this.#trySend(conversationId, chunk)
    if (!refused) {
      if (this.#config.sendDelayMs > 0) await delay(this.#config.sendDelayMs)
      return true
    }

    const queue = this.#queueFor(conversationId)
    queue.push(chunk)
    this.#setQueue(conversationId, queue.slice(-20))
    if (refused.errcode === LOCAL_FAILURE) this.#log.warn(`send failed: ${refused.message}`)
    else this.#log.warn(`send refused (errcode=${refused.errcode}): ${refused.message} | 内容：${preview(chunk, 60)}`)
    this.#scheduleRetry(conversationId)
    if (throwOnFailure) throw refused
    return false
  }

  /*
   * -------------------------------------------------------------------------
   * Outbound queue (persisted)
   * -------------------------------------------------------------------------
   */

  /** Text waiting to be delivered to a conversation. */
  #queueFor(conversationId: string): string[] {
    return this.#state.pendingOutbound?.[conversationId] ?? []
  }

  #setQueue(conversationId: string, items: string[]): void {
    this.#state = updateState((state) => {
      const next = { ...(state.pendingOutbound ?? {}) }
      if (items.length === 0) delete next[conversationId]
      else next[conversationId] = items
      state.pendingOutbound = next
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
      void this.#flushQueue(conversationId)
    }, delayMs)
    timer.unref?.()
    this.#retryTimers.set(conversationId, timer)
  }

  /** Try to deliver everything queued for a conversation. */
  async #flushQueue(conversationId: string): Promise<void> {
    const queue = this.#queueFor(conversationId)
    if (queue.length === 0) {
      this.#setRetryAttempt(conversationId, 0)
      return
    }

    const remaining: string[] = []
    for (let index = 0; index < queue.length; index += 1) {
      if (remaining.length > 0) {
        remaining.push(queue[index])
        continue
      }
      const refused = await this.#trySend(conversationId, queue[index])
      if (refused) {
        this.#log.warn(`queued send still refused (errcode=${refused.errcode})`)
        remaining.push(queue[index])
      } else {
        this.#log.info("queued send delivered")
      }
    }

    if (remaining.length === 0) {
      this.#setQueue(conversationId, [])
      this.#setRetryAttempt(conversationId, 0)
      if (queue.length > 0) this.#lastFlushedAt.set(conversationId, Date.now())
      return
    }

    this.#setQueue(conversationId, remaining)
    this.#scheduleRetry(conversationId)
  }

  /*
   * -------------------------------------------------------------------------
   * Typing indicator
   * -------------------------------------------------------------------------
   */

  async #setTyping(conversationId: string, typing: boolean): Promise<void> {
    const account = this.#state.account
    if (!account?.token) return
    const peerId = conversationId.split(":").pop()
    if (!peerId) return

    if (!typing) {
      const timer = this.#typingTimers.get(conversationId)
      if (timer) {
        clearInterval(timer)
        this.#typingTimers.delete(conversationId)
      }
    }

    const ticket = this.#typingTickets.get(peerId) ?? (await this.#fetchTypingTicket(peerId))
    if (!ticket) return

    try {
      await sendTyping({ account, userId: peerId, ticket, typing })
    } catch (error) {
      this.#log.warn(`typing failed: ${errorText(error)}`)
      return
    }

    if (!typing || this.#typingTimers.has(conversationId)) return
    // The indicator expires on its own; refresh while the turn runs.
    const timer = setInterval(() => {
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

/** One-line, length-capped excerpt for log lines. */
function preview(text: string, limit = 80): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit)
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
    while (rest.length > 0) {
      const head = current === "" ? "" : "\n"
      const room = budget - current.length - head.length
      if (room <= 0) {
        flush()
        continue
      }
      if (rest.length <= room) {
        current += head + rest
        return
      }
      // The piece does not fit next to what is buffered. Start a fresh chunk
      // first — unless the piece is longer than a whole chunk, in which case it
      // cannot fit anywhere and has to be cut.
      if (current !== "") {
        flush()
        continue
      }
      const slice = rest.slice(0, budget)
      const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("，"), slice.lastIndexOf("、"))
      const take = breakAt > budget * 0.6 ? breakAt + 1 : budget
      current = rest.slice(0, take)
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
