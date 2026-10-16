/**
 * Tencent iLink Bot protocol client.
 *
 * This is the wire layer behind the official WeChat ClawBot plugin: the same
 * HTTP JSON protocol the OpenClaw channel `@tencent-weixin/openclaw-weixin`
 * speaks. Nothing here depends on OpenCode, so it can be tested on its own.
 *
 * Protocol notes that matter:
 *  - Login is a long-poll QR handshake. Sending `local_token_list` lets the
 *    server hand back an existing binding instead of creating a new bot
 *    identity, which is what makes a re-login reuse the account rather than
 *    silently rebind it.
 *  - Every send endpoint answers HTTP 200 whether the service accepted the
 *    message or not; a refusal shows up as a non-zero `errcode`/`ret`. Reading
 *    only `message_id` makes "delivered" and "refused" indistinguishable.
 *  - `errcode -14` means the bot token is stale (the conversation went quiet).
 *    Tencent's own client pauses the account for an hour instead of retrying.
 *  - Several identifiers are `uint64`. A plain JSON.parse silently rounds
 *    19-digit ids, so id fields are quoted before parsing.
 */

import { randomBytes } from "node:crypto"

export const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com"
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

/** Tenant/application id, sent as `iLink-App-Id`. */
export const APP_ID = "bot"
/** Client build number, sent as `iLink-App-ClientVersion` (0x00MMNNPP). */
export const APP_CLIENT_VERSION = "204009"
/** Reported in `base_info.channel_version`. Observability only. */
export const CHANNEL_VERSION = "2.4.9"
/** Reported in `base_info.bot_agent`. Observability only, never used for routing. */
export const BOT_AGENT = "opencode-wechat/1.0.0"
/** `bot_type` for the WeChat channel build. */
export const DEFAULT_BOT_TYPE = "3"

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
export const DEFAULT_API_TIMEOUT_MS = 15_000
export const DEFAULT_QR_POLL_TIMEOUT_MS = 35_000

/** Server error code meaning the bot token is stale. */
export const STALE_TOKEN_ERRCODE = -14
/** Tencent's cool-down after a stale token. */
export const SESSION_PAUSE_MS = 60 * 60 * 1000
export const MAX_CONSECUTIVE_FAILURES = 3
export const RETRY_DELAY_MS = 2_000
export const BACKOFF_DELAY_MS = 30_000
/** How many times one login session may replace an expired QR code. */
export const MAX_QR_REFRESH = 3

/** Message item types. */
export const ItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

/** `message_type` on the wire. */
export const MessageType = { USER: 1, BOT: 2 } as const
/** `message_state` on the wire. */
export const MessageState = { NEW: 0, GENERATING: 1, FINISHED: 2 } as const
/** `sendtyping` status. */
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const
/** `media_type` accepted by `getuploadurl`. */
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const

export interface WeixinAccount {
  /** `ilink_bot_id`, e.g. `xxx@im.bot`. */
  accountId: string
  token: string
  baseUrl: string
  /** The WeChat account that scanned the QR code. */
  userId?: string
  savedAt?: string
  boundAt?: string
}

export interface MediaRef {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface MessageItem {
  type?: number
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  text_item?: { text?: string }
  image_item?: { aeskey?: string; mid_size?: number; media?: MediaRef; thumb_media?: MediaRef }
  voice_item?: { text?: string; media?: MediaRef; encode_type?: number; sample_rate?: number; playtime?: number }
  file_item?: { file_name?: string; len?: string; media?: MediaRef }
  video_item?: { video_size?: number; media?: MediaRef; thumb_media?: MediaRef }
  ref_msg?: { message_item?: MessageItem; title?: string }
}

export interface WeixinMessage {
  seq?: number
  message_id?: string
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  update_time_ms?: number
  delete_time_ms?: number
  session_id?: string
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  context_token?: string
  run_id?: string
}

export interface BaseInfo {
  channel_version: string
  bot_agent?: string
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageResp {
  ret?: number
  errcode?: number
  errmsg?: string
  message_id?: string
}

export interface GetConfigResp {
  ret?: number
  errcode?: number
  errmsg?: string
  typing_ticket?: string
}

export interface QRCodeResponse {
  qrcode: string
  qrcode_img_content: string
}

export interface QRStatusResponse {
  status: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
  verify_code?: string
}

/**
 * The service accepted the request at the HTTP level but refused the message.
 *
 * Distinct from every other failure because the reply window is closed: the
 * next inbound message reopens it, so keeping the text until then is useful
 * while retrying immediately is not.
 */
export class SendRefusedError extends Error {
  readonly errcode: number
  constructor(message: string, errcode: number) {
    super(message)
    this.name = "SendRefusedError"
    this.errcode = errcode
  }
}

export class ApiHttpError extends Error {
  readonly status: number
  readonly endpoint: string
  constructor(endpoint: string, status: number, body: string) {
    // The body is echoed back by gateways (some debug-echo request headers) and
    // this message is logged *and* forwarded to the phone, so credentials are
    // stripped before that can happen.
    super(`${endpoint} HTTP ${status}: ${redactSecrets(body).slice(0, 300)}`)
    this.name = "ApiHttpError"
    this.status = status
    this.endpoint = endpoint
  }
}

/**
 * Normalise a wire error code.
 *
 * The gateway is JavaScript-shaped and has been seen sending codes as strings
 * (`"0"`, `"-14"`). Comparing those with `=== 0` inverts every decision: an
 * accepted send looks refused (the phone goes silent while the queue retries
 * forever) and a dead token is retried instead of asking for a re-scan.
 */
export function toCode(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  const parsed = Number(String(value).trim())
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Strip credential-shaped text before it reaches a log, a chat message or a
 * tool result.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1<已隐去>")
    .replace(
      /((?:bot_token|token|password|passwd|secret|aes_key|authorization|client_secret|verify_code|qrcode)\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{6,}/gi,
      "$1<已隐去>",
    )
    .replace(/\b[A-Za-z0-9_\-+/=]{40,}\b/g, "<已隐去>")
}

/** Hosts the bridge is willing to talk to. Anything else is treated as hostile. */
const TRUSTED_HOST_SUFFIXES = [".weixin.qq.com", ".qq.com"] as const

export function isTrustedHost(host: string): boolean {
  const lowered = host.toLowerCase()
  return TRUSTED_HOST_SUFFIXES.some((suffix) => lowered.endsWith(suffix))
}

/**
 * Validate a URL that came from the network (QR status, `getupdates`, media).
 *
 * The bot token travels as a bearer header, so a hostile DNS/DHCP/portal answer
 * that redirects the base URL would exfiltrate it. On Bun `fetch("file://…")`
 * also reads local files, which would copy `state.json` into the inbox and hand
 * it to the model. Only https to a trusted WeChat host is accepted; loopback is
 * allowed because that is how the tests' mock servers work.
 */
export function assertTrustedUrl(url: string, what: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${what} 不是合法 URL：${url.slice(0, 120)}`)
  }
  const host = parsed.hostname.toLowerCase()
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host)
  // The scheme check comes first: on Bun `fetch("file://…")` reads local files,
  // so a loopback host with a `file:` scheme used to slip through and copy
  // state.json (with the bot token) into the inbox.
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    throw new Error(`${what} 必须走 https（回环测试除外）：${parsed.protocol}//${parsed.host}`)
  }
  if (loopback) return parsed
  if (!isTrustedHost(host)) {
    throw new Error(`${what} 指向非腾讯域名，已拒绝：${host}`)
  }
  return parsed
}

/** Whether a network URL is safe to fetch. */
export function isTrustedUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    assertTrustedUrl(url, "URL")
    return true
  } catch {
    return false
  }
}

/** Largest API answer the bridge is willing to buffer (a portal page is not). */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024

/** Read a response body with a hard cap, so a hostile answer cannot exhaust memory. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`响应体声明 ${declared} 字节，超过上限 ${maxBytes}`)
  }
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`响应体超过上限 ${maxBytes} 字节`)
    return text
  }
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`响应体超过上限 ${maxBytes} 字节`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString("utf8")
}

const LOSSLESS_ID_FIELDS = ["message_id", "msg_id", "svr_id"] as const

/**
 * Parse a wire body without losing `uint64` precision on id fields.
 *
 * The rewrite runs on a scanner that consumes whole string literals first, so
 * message *content* that happens to contain `"msg_id": 123…` is left alone —
 * a plain global replace used to rewrite the user's own text before it reached
 * the model.
 */
export function parseWireJson<T>(raw: string): T {
  const alternation = LOSSLESS_ID_FIELDS.join("|")
  // Order matters: the key/value pair is tried first, and only when it does not
  // match is a whole string literal consumed. That way a message whose *text*
  // contains `"msg_id": 123…` is read as one opaque string and left untouched.
  const scanner = new RegExp(`"(${alternation})"\\s*:\\s*(\\d{6,})|"(?:[^"\\\\]|\\\\.)*"`, "g")
  const rewritten = raw.replace(scanner, (match: string, key?: string, digits?: string) =>
    key === undefined ? match : `"${key}":"${digits}"`,
  )
  return JSON.parse(rewritten) as T
}

/** `X-WECHAT-UIN`: a random uint32 rendered as a decimal string, then base64. */
function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64")
}

export function baseInfo(botAgent: string = BOT_AGENT): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: botAgent }
}

/**
 * Client-side message id.
 *
 * The official client uses `<prefix>:<millis>-<hex>`; the service is picky
 * enough about this field that matching the shape is worth it (a UUID-shaped
 * id was accepted for other calls but is not what the backend expects).
 */
export function newClientId(prefix = "opencode-wechat"): string {
  return `${prefix}:${Date.now()}-${randomBytes(4).toString("hex")}`
}

export function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": APP_CLIENT_VERSION,
    "X-WECHAT-UIN": randomWechatUin(),
  }
  const trimmed = token?.trim()
  if (trimmed) {
    headers.AuthorizationType = "ilink_bot_token"
    headers.Authorization = `Bearer ${trimmed}`
  }
  return headers
}

export interface ApiRequest {
  baseUrl: string
  endpoint: string
  method?: "GET" | "POST"
  body?: unknown
  token?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** Perform one call and return the untouched body text. */
export async function apiCallRaw(request: ApiRequest): Promise<string> {
  const base = request.baseUrl.endsWith("/") ? request.baseUrl : `${request.baseUrl}/`
  const url = new URL(request.endpoint, base)
  // The base URL comes from a QR-status answer, i.e. from the network. Validate
  // it on every call (and refuse redirects below) so a hijacked answer cannot
  // walk off with the bearer token.
  assertTrustedUrl(url.toString(), `iLink 请求 ${request.endpoint}`)
  const timeout = request.timeoutMs ?? DEFAULT_API_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const signal = combineSignals(controller.signal, request.signal)

  try {
    const response = await fetch(url.toString(), {
      method: request.method ?? "POST",
      headers: buildHeaders(request.token),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      redirect: "error",
      signal,
    })
    const text = await readBoundedText(response, MAX_API_BODY_BYTES)
    if (!response.ok) throw new ApiHttpError(request.endpoint, response.status, text)
    // A captive portal answers 200 with an HTML page. Only *that* is diagnosed
    // here: the real iLink gateway answers valid JSON with
    // `content-type: application/octet-stream`, so a content-type check alone
    // would reject the actual server (which it did, once, until the probe in
    // the logs showed the gateway's real header).
    const trimmed = text.trimStart()
    if (trimmed.startsWith("<")) {
      const type = (response.headers.get("content-type") ?? "").toLowerCase()
      throw new Error(
        `${request.endpoint} 返回的是网页而不是 JSON（content-type: ${type || "无"}）——校园网/酒店门户会这样，先完成认证再重试`,
      )
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Perform one call and return the decoded JSON. */
export async function apiCall<T>(request: ApiRequest): Promise<T> {
  return parseWireJson<T>(await apiCallRaw(request))
}

/**
 * Call an endpoint that may answer with an empty body.
 *
 * `apiCall` parses JSON, so a 200 with no body throws a syntax error that looks
 * like a transport failure; these endpoints (typing, notify) report refusals
 * through `ret`/`errcode` instead, and that is worth surfacing.
 */
export async function apiCallVoid(request: ApiRequest): Promise<void> {
  const raw = await apiCallRaw(request)
  if (!raw.trim()) return
  const response = parseWireJson<{ ret?: number; errcode?: number; errmsg?: string }>(raw)
  const code = toCode(response.errcode ?? response.ret)
  if (code !== undefined && code !== 0) {
    throw new Error(
      `${request.endpoint} 失败 ret=${response.ret} errcode=${response.errcode} errmsg=${redactSecrets(String(response.errmsg ?? ""))}`,
    )
  }
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a.aborted) return a
  if (b.aborted) return b
  // `AbortSignal.any` keeps no listener of its own on the source signals, and
  // that matters here: the monitor hands the same long-lived signal to every
  // poll, so manual listeners used to accumulate one per request for the whole
  // process lifetime (thousands after a day of running).
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b])
  const controller = new AbortController()
  const onAbort = (): void => {
    a.removeEventListener("abort", onAbort)
    b.removeEventListener("abort", onAbort)
    controller.abort()
  }
  a.addEventListener("abort", onAbort, { once: true })
  b.addEventListener("abort", onAbort, { once: true })
  return controller.signal
}

/*
 * ---------------------------------------------------------------------------
 * Login
 * ---------------------------------------------------------------------------
 */

export type LoginEvent =
  | { kind: "qr"; qrUrl: string; qrcode: string; refreshed: boolean }
  | { kind: "scanned" }
  | { kind: "verifycode-required"; attempt: number }
  | { kind: "redirected"; host: string }
  | { kind: "expired"; refreshCount: number; willRetry: boolean }
  | { kind: "already-bound" }
  | { kind: "confirmed"; account: WeixinAccount }
  | { kind: "failed"; reason: string }

export interface LoginOptions {
  /**
   * Bot tokens this deployment already holds, newest first.
   *
   * Sent as `local_token_list`. Omitting it makes the server treat the client
   * as brand new, which rebinds the account — the exact damage a second
   * machine causes by scanning naively.
   */
  existingTokens?: readonly string[]
  botType?: string
  timeoutMs?: number
  baseUrl?: string
  signal?: AbortSignal
  /** Called for every step, so callers can render or log progress. */
  onEvent?: (event: LoginEvent) => void
  /**
   * Called when an event handler rejects.
   *
   * Handlers are async (writing the QR image, saving the account) and used to be
   * fired without awaiting, so a rejection became an unhandled one that could
   * take the host process down. The failure is reported here instead.
   */
  onEventError?: (error: unknown) => void
  /**
   * Asked when the server wants a pairing verification code.
   *
   * Returning `undefined` aborts the login: a non-interactive caller such as
   * the in-process plugin cannot collect a code, so it must say so rather than
   * hang.
   */
  requestVerifyCode?: (attempt: number) => Promise<string | undefined>
}

export interface LoginResult {
  account?: WeixinAccount
  alreadyBound: boolean
  reason?: string
}

export async function fetchQRCode(params: {
  localTokenList?: readonly string[]
  botType?: string
  baseUrl?: string
  signal?: AbortSignal
}): Promise<QRCodeResponse> {
  return apiCall<QRCodeResponse>({
    baseUrl: params.baseUrl ?? FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(params.botType ?? DEFAULT_BOT_TYPE)}`,
    method: "POST",
    body: { local_token_list: [...(params.localTokenList ?? [])] },
    timeoutMs: 20_000,
    signal: params.signal,
  })
}

export async function pollQRStatus(params: {
  qrcode: string
  verifyCode?: string
  baseUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<QRStatusResponse> {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`
  if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`
  try {
    return await apiCall<QRStatusResponse>({
      baseUrl: params.baseUrl ?? FIXED_BASE_URL,
      endpoint,
      method: "GET",
      timeoutMs: params.timeoutMs ?? DEFAULT_QR_POLL_TIMEOUT_MS,
      signal: params.signal,
    })
  } catch (error) {
    // A held request we stopped waiting on is indistinguishable from "nothing yet".
    if (isAbort(error)) return { status: "wait" }
    throw error
  }
}

/** Drive a full QR login handshake. Resolves with the account on success. */
export async function login(options: LoginOptions = {}): Promise<LoginResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)
  const localTokenList = [...(options.existingTokens ?? [])]
  // Events are delivered one at a time: handlers do real work (writing the QR
  // image, saving the account) and are async, so firing them concurrently both
  // reorders those side effects and — before this — let a rejection escape.
  let emission: Promise<void> = Promise.resolve()
  const emit = (event: LoginEvent): void => {
    const handler = options.onEvent
    if (!handler) return
    emission = emission
      .then(
        () => handler(event),
        () => handler(event),
      )
      .then(
        () => undefined,
        (error) => options.onEventError?.(error),
      )
  }

  let baseUrl = options.baseUrl ?? FIXED_BASE_URL
  let qr: QRCodeResponse
  try {
    qr = await fetchQRCode({ localTokenList, botType: options.botType, baseUrl, signal: options.signal })
  } catch (error) {
    const reason = `获取二维码失败：${errorMessage(error)}`
    emit({ kind: "failed", reason })
    return { alreadyBound: false, reason }
  }
  emit({ kind: "qr", qrUrl: qr.qrcode_img_content, qrcode: qr.qrcode, refreshed: false })

  let verifyCode: string | undefined
  let scannedNotified = false
  let refreshCount = 0
  let verifyAttempt = 0

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return { alreadyBound: false, reason: "cancelled" }

    let status: QRStatusResponse
    try {
      status = await pollQRStatus({ qrcode: qr.qrcode, verifyCode, baseUrl, signal: options.signal })
    } catch (error) {
      // A transient failure must not abort a login the user is mid-scan on.
      if (isAbort(error) && options.signal?.aborted) return { alreadyBound: false, reason: "cancelled" }
      await sleep(1_500, options.signal)
      continue
    }

    switch (status.status) {
      case "wait":
        break

      case "scaned":
        if (!scannedNotified) {
          scannedNotified = true
          emit({ kind: "scanned" })
        }
        // The verified code has served its purpose; do not resend it.
        verifyCode = undefined
        break

      case "need_verifycode": {
        verifyAttempt += 1
        if (verifyAttempt > 3) {
          const reason = "验证码多次未通过"
          emit({ kind: "failed", reason })
          return { alreadyBound: false, reason }
        }
        emit({ kind: "verifycode-required", attempt: verifyAttempt })
        try {
          verifyCode = await options.requestVerifyCode?.(verifyAttempt)
        } catch {
          // A collector that fails is the same as one that cannot collect: say
          // so instead of letting the rejection escape the login flow.
          verifyCode = undefined
        }
        if (!verifyCode) {
          const reason = "需要输入配对验证码，但当前环境无法交互输入"
          emit({ kind: "failed", reason })
          return { alreadyBound: false, reason }
        }
        break
      }

      case "verify_code_blocked": {
        const reason = "验证码被服务端锁定，请稍后重试"
        emit({ kind: "failed", reason })
        return { alreadyBound: false, reason }
      }

      case "expired": {
        refreshCount += 1
        const willRetry = refreshCount <= MAX_QR_REFRESH
        emit({ kind: "expired", refreshCount, willRetry })
        if (!willRetry) {
          const reason = "二维码反复过期"
          emit({ kind: "failed", reason })
          return { alreadyBound: false, reason }
        }
        try {
          qr = await fetchQRCode({ localTokenList, botType: options.botType, baseUrl, signal: options.signal })
        } catch (error) {
          // A transient network blip mid-scan must end the flow with a reason,
          // not with an exception nobody catches.
          const reason = `刷新二维码失败：${errorMessage(error)}`
          emit({ kind: "failed", reason })
          return { alreadyBound: false, reason }
        }
        emit({ kind: "qr", qrUrl: qr.qrcode_img_content, qrcode: qr.qrcode, refreshed: true })
        scannedNotified = false
        verifyCode = undefined
        break
      }

      case "scaned_but_redirect": {
        if (status.redirect_host) {
          // Verified before use: this is the network telling the bot where to
          // send its token next.
          if (isTrustedUrl(`https://${status.redirect_host}`)) {
            emit({ kind: "redirected", host: status.redirect_host })
            baseUrl = `https://${status.redirect_host}`
          } else {
            emit({ kind: "failed", reason: `服务端要求切换到非腾讯域名，已拒绝：${status.redirect_host}` })
            return { alreadyBound: false, reason: `拒绝切换到 ${status.redirect_host}` }
          }
        }
        break
      }

      case "binded_redirect": {
        // The account already has a binding; adopting it is the point of `local_token_list`.
        emit({ kind: "already-bound" })
        return { alreadyBound: true, reason: "服务端回复该账号已与某个 bot 绑定" }
      }

      case "confirmed": {
        const account = accountFromStatus(status, baseUrl)
        if (!account) {
          const reason = status.ilink_bot_id ? "服务端未返回 bot_token" : "服务端未返回 ilink_bot_id"
          emit({ kind: "failed", reason })
          return { alreadyBound: false, reason }
        }
        emit({ kind: "confirmed", account })
        return { account, alreadyBound: false }
      }

      default: {
        const reason = `未预期的二维码状态: ${String((status as { status?: string }).status)}`
        emit({ kind: "failed", reason })
        return { alreadyBound: false, reason }
      }
    }

    await sleep(1_000, options.signal)
  }

  const reason = "登录超时"
  emit({ kind: "failed", reason })
  return { alreadyBound: false, reason }
}

function accountFromStatus(status: QRStatusResponse, fallbackBaseUrl: string): WeixinAccount | undefined {
  if (!status.ilink_bot_id) return undefined
  const token = status.bot_token?.trim()
  if (!token) return undefined
  const now = new Date().toISOString()
  // The answer carries a base URL, i.e. the network chooses where the token
  // will be sent from now on: only a trusted WeChat host (or the known-good
  // fallback) is adopted, so a hijacked answer cannot point the bot elsewhere.
  const offered = status.baseurl?.trim()
  const baseUrl = offered && isTrustedUrl(offered) ? offered : fallbackBaseUrl
  return {
    accountId: status.ilink_bot_id,
    token,
    baseUrl,
    ...(status.ilink_user_id === undefined ? {} : { userId: status.ilink_user_id }),
    savedAt: now,
    boundAt: now,
  }
}

/*
 * ---------------------------------------------------------------------------
 * Sending
 * ---------------------------------------------------------------------------
 */

/**
 * Throw when the service refused a send.
 *
 * `errcode ?? ret` because the send endpoints use `errcode` while the polling
 * endpoint has been seen with either.
 */
export function assertSendAccepted(response: SendMessageResp): void {
  const code = toCode(response.errcode ?? response.ret)
  if (code === undefined || code === 0) return
  const reason = redactSecrets(String(response.errmsg ?? ""))
  if (code === STALE_TOKEN_ERRCODE) {
    throw new SendRefusedError("微信会话已超时，需要你先在微信里发一条消息再主动推送", code)
  }
  throw new SendRefusedError(`发送被微信拒绝：errcode=${String(code)} errmsg=${reason || "(无)"}`, code)
}

/**
 * Longest text the service accepts in one message.
 *
 * The official outbound config uses 4000; anything longer is truncated by the
 * server, which on the phone looks exactly like the model stopping mid-reply.
 */
export const MAX_TEXT_CHARS = 4_000

export interface SendTextParams {
  account: WeixinAccount
  to: string
  text: string
  contextToken?: string
  runId?: string
  signal?: AbortSignal
  /**
   * Reuse a client id (idempotency).
   *
   * The service dedupes on `client_id`, so a retry of the *same* logical
   * message must send the same id — otherwise an ambiguous timeout (the answer
   * was lost, the message was accepted) delivers the text twice.
   */
  clientId?: string
}

/** Send one text message. Throws `SendRefusedError` when the service refuses it. */
export async function sendText(params: SendTextParams): Promise<{ clientId: string; serverMessageId?: string }> {
  const text = params.text ?? ""
  // Refuse here rather than let the service cut the tail off silently.
  if (text.trim().length === 0) throw new Error("不能发送空消息")
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(`单条消息 ${text.length} 字符，超过服务端上限 ${MAX_TEXT_CHARS}`)
  }
  const clientId = params.clientId?.trim() || newClientId()
  const response = await apiCall<SendMessageResp>({
    baseUrl: params.account.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: {
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISHED,
        item_list: [{ type: ItemType.TEXT, text_item: { text } }],
        ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
        ...(params.runId === undefined ? {} : { run_id: params.runId }),
      },
      base_info: baseInfo(),
    },
    token: params.account.token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    signal: params.signal,
  })
  assertSendAccepted(response)
  return {
    clientId,
    ...(response.message_id === undefined ? {} : { serverMessageId: response.message_id }),
  }
}

/** Fetch the typing ticket for one user. Required before `sendtyping` works. */
export async function getTypingTicket(params: {
  account: WeixinAccount
  userId: string
  contextToken?: string
  signal?: AbortSignal
}): Promise<string | undefined> {
  const response = await apiCall<GetConfigResp>({
    baseUrl: params.account.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: {
      ilink_user_id: params.userId,
      ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
      base_info: baseInfo(),
    },
    token: params.account.token,
    timeoutMs: 10_000,
    signal: params.signal,
  })
  // A refusal used to be invisible here: the caller just got "no ticket" and the
  // indicator stayed off forever without a single log line.
  const code = toCode(response.errcode ?? response.ret)
  if (code !== undefined && code !== 0) {
    throw new Error(
      `getconfig 失败 ret=${response.ret} errcode=${response.errcode} errmsg=${redactSecrets(String(response.errmsg ?? ""))}`,
    )
  }
  return response.typing_ticket
}

export async function sendTyping(params: {
  account: WeixinAccount
  userId: string
  ticket: string
  typing: boolean
  signal?: AbortSignal
}): Promise<void> {
  await apiCallVoid({
    baseUrl: params.account.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: params.userId,
      typing_ticket: params.ticket,
      status: params.typing ? TypingStatus.TYPING : TypingStatus.CANCEL,
      base_info: baseInfo(),
    },
    token: params.account.token,
    timeoutMs: 10_000,
    signal: params.signal,
  })
}

export async function notifyStart(account: WeixinAccount): Promise<void> {
  await apiCallVoid({
    baseUrl: account.baseUrl,
    endpoint: "ilink/bot/msg/notifystart",
    body: { base_info: baseInfo() },
    token: account.token,
    timeoutMs: 8_000,
  })
}

/*
 * ---------------------------------------------------------------------------
 * Media
 * ---------------------------------------------------------------------------
 */

export interface UploadUrlResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  upload_param?: string
  thumb_upload_param?: string
  upload_full_url?: string
}

export interface UploadedMedia {
  /** CDN download parameter taken from the upload response header. */
  downloadParam: string
  /** AES-128-ECB key as a hex string. */
  aesKeyHex: string
  /** Plaintext byte size. */
  plainSize: number
  /** Ciphertext byte size (PKCS#7 padding to a 16-byte boundary). */
  cipherSize: number
}

/**
 * Ask the service for upload parameters.
 *
 * `filesize` is the *padded* size and `rawfilemd5` the hash of the plaintext:
 * the service verifies both when the ciphertext is uploaded.
 */
export async function getUploadUrl(params: {
  account: WeixinAccount
  filekey: string
  mediaType: number
  toUserId: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  aeskey: string
  signal?: AbortSignal
}): Promise<UploadUrlResponse> {
  const response = await apiCall<UploadUrlResponse>({
    baseUrl: params.account.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: true,
      aeskey: params.aeskey,
      base_info: baseInfo(),
    },
    token: params.account.token,
    timeoutMs: 20_000,
    signal: params.signal,
  })
  const code = toCode(response.errcode ?? response.ret)
  if (code !== undefined && code !== 0) {
    throw new SendRefusedError(
      `获取上传参数被拒：errcode=${String(code)} errmsg=${redactSecrets(String(response.errmsg ?? "")) || "(无)"}`,
      code,
    )
  }
  // The upload URL comes from the network and the file is POSTed to it: a
  // hostile answer must not be able to redirect the content elsewhere.
  if (response.upload_full_url && !isTrustedUrl(response.upload_full_url)) {
    response.upload_full_url = undefined
  }
  return response
}

/**
 * The media reference a message item carries.
 *
 * `aes_key` is base64 of the hex *text*, not of the raw 16 bytes. Getting this
 * wrong is invisible on send: the service accepts it and the phone renders a
 * grey box.
 */
export function buildMediaRef(uploaded: UploadedMedia): MediaRef {
  return {
    encrypt_query_param: uploaded.downloadParam,
    aes_key: Buffer.from(uploaded.aesKeyHex, "utf8").toString("base64"),
    encrypt_type: 1,
  }
}

/** Image item: `media` plus the ciphertext size, and nothing else. */
export function imageItem(uploaded: UploadedMedia): MessageItem {
  return { type: ItemType.IMAGE, image_item: { media: buildMediaRef(uploaded), mid_size: uploaded.cipherSize } }
}

/** File item: `media`, `file_name` and the plaintext size as a string. */
export function fileItem(uploaded: UploadedMedia, fileName: string): MessageItem {
  return {
    type: ItemType.FILE,
    file_item: { media: buildMediaRef(uploaded), file_name: fileName, len: String(uploaded.plainSize) },
  }
}

/** Video item: `media` plus the ciphertext size. */
export function videoItem(uploaded: UploadedMedia): MessageItem {
  return { type: ItemType.VIDEO, video_item: { media: buildMediaRef(uploaded), video_size: uploaded.cipherSize } }
}

export function textItem(text: string): MessageItem {
  return { type: ItemType.TEXT, text_item: { text } }
}

/**
 * Send one message carrying an arbitrary item list.
 *
 * Every item is sent as its own request so that `item_list` always holds exactly
 * one entry — the shape the official client uses and the one the service
 * reliably accepts.
 */
export async function sendItems(params: {
  account: WeixinAccount
  to: string
  items: MessageItem[]
  contextToken?: string
  runId?: string
  signal?: AbortSignal
}): Promise<{ clientId: string; serverMessageId?: string }> {
  let clientId = ""
  let serverMessageId: string | undefined

  for (const item of params.items) {
    clientId = newClientId()
    const response = await apiCall<SendMessageResp>({
      baseUrl: params.account.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: {
        msg: {
          from_user_id: "",
          to_user_id: params.to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISHED,
          item_list: [item],
          ...(params.contextToken === undefined ? {} : { context_token: params.contextToken }),
          ...(params.runId === undefined ? {} : { run_id: params.runId }),
        },
        base_info: baseInfo(),
      },
      token: params.account.token,
      timeoutMs: DEFAULT_API_TIMEOUT_MS,
      signal: params.signal,
    })
    assertSendAccepted(response)
    serverMessageId = response.message_id
  }

  return { clientId, ...(serverMessageId === undefined ? {} : { serverMessageId }) }
}

export async function notifyStop(account: WeixinAccount): Promise<void> {
  try {
    await apiCallVoid({
      baseUrl: account.baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      body: { base_info: baseInfo() },
      token: account.token,
      timeoutMs: 5_000,
    })
  } catch {
    // Nothing useful to do while shutting down.
  }
}

/*
 * ---------------------------------------------------------------------------
 * Inbound helpers
 * ---------------------------------------------------------------------------
 */

/** True when the item carries a downloadable attachment. */
export function isMediaItem(item: MessageItem): boolean {
  if (item.type === ItemType.IMAGE) return Boolean(item.image_item?.media)
  if (item.type === ItemType.FILE) return Boolean(item.file_item?.media)
  if (item.type === ItemType.VIDEO) return Boolean(item.video_item?.media)
  if (item.type === ItemType.VOICE) return Boolean(item.voice_item?.media)
  return false
}

/** Concatenate text items plus any server-side voice transcript. */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Already aborted: the `abort` event fired before the listener existed, so
    // waiting the full duration would ignore the cancellation (up to 30s in the
    // monitor's backoff path).
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}
