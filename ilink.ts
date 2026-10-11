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
    super(`${endpoint} HTTP ${status}: ${body.slice(0, 300)}`)
    this.name = "ApiHttpError"
    this.status = status
    this.endpoint = endpoint
  }
}

const LOSSLESS_ID_FIELDS = ["message_id", "msg_id", "svr_id"] as const

/** Parse a wire body without losing `uint64` precision on id fields. */
export function parseWireJson<T>(raw: string): T {
  const alternation = LOSSLESS_ID_FIELDS.join("|")
  const rewritten = raw.replace(new RegExp(`"(${alternation})"\\s*:\\s*(\\d{6,})`, "g"), '"$1":"$2"')
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
  const timeout = request.timeoutMs ?? DEFAULT_API_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const signal = combineSignals(controller.signal, request.signal)

  try {
    const response = await fetch(url.toString(), {
      method: request.method ?? "POST",
      headers: buildHeaders(request.token),
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal,
    })
    const text = await response.text()
    if (!response.ok) throw new ApiHttpError(request.endpoint, response.status, text)
    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Perform one call and return the decoded JSON. */
export async function apiCall<T>(request: ApiRequest): Promise<T> {
  return parseWireJson<T>(await apiCallRaw(request))
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a.aborted) return a
  if (b.aborted) return b
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
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
  const emit = (event: LoginEvent): void => options.onEvent?.(event)

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
        verifyCode = await options.requestVerifyCode?.(verifyAttempt)
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
        qr = await fetchQRCode({ localTokenList, botType: options.botType, baseUrl, signal: options.signal })
        emit({ kind: "qr", qrUrl: qr.qrcode_img_content, qrcode: qr.qrcode, refreshed: true })
        scannedNotified = false
        verifyCode = undefined
        break
      }

      case "scaned_but_redirect": {
        if (status.redirect_host) {
          emit({ kind: "redirected", host: status.redirect_host })
          baseUrl = `https://${status.redirect_host}`
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
  return {
    accountId: status.ilink_bot_id,
    token,
    baseUrl: status.baseurl?.trim() || fallbackBaseUrl,
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
  const code = response.errcode ?? response.ret
  if (code === undefined || code === 0) return
  if (code === STALE_TOKEN_ERRCODE) {
    throw new SendRefusedError("微信会话已超时，需要你先在微信里发一条消息再主动推送", code)
  }
  throw new SendRefusedError(`发送被微信拒绝：errcode=${String(code)} errmsg=${response.errmsg ?? "(无)"}`, code)
}

export interface SendTextParams {
  account: WeixinAccount
  to: string
  text: string
  contextToken?: string
  runId?: string
  signal?: AbortSignal
}

/** Send one text message. Throws `SendRefusedError` when the service refuses it. */
export async function sendText(params: SendTextParams): Promise<{ clientId: string; serverMessageId?: string }> {
  const clientId = newClientId()
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
        item_list: params.text ? [{ type: ItemType.TEXT, text_item: { text: params.text } }] : undefined,
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
  })
  return response.typing_ticket
}

export async function sendTyping(params: {
  account: WeixinAccount
  userId: string
  ticket: string
  typing: boolean
}): Promise<void> {
  await apiCall({
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
  })
}

export async function notifyStart(account: WeixinAccount): Promise<void> {
  await apiCall({
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
  const code = response.errcode ?? response.ret
  if (code !== undefined && code !== 0) {
    throw new SendRefusedError(
      `获取上传参数被拒：errcode=${String(code)} errmsg=${response.errmsg ?? "(无)"}`,
      code,
    )
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
    await apiCall({
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
export function extractText(message: WeixinMessage): string {
  const parts: string[] = []
  for (const item of message.item_list ?? []) {
    if (item.type === ItemType.TEXT && item.text_item?.text) parts.push(item.text_item.text)
    // Inbound voice usually carries a server-side transcript.
    else if (item.type === ItemType.VOICE && item.voice_item?.text) parts.push(item.voice_item.text)
  }
  return parts.join("\n").trim()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}
