/**
 * Media in both directions.
 *
 * Inbound: WeChat media is AES-128-ECB encrypted on a CDN. Two protocol details
 * are easy to get wrong and are handled here — the key arrives either as a
 * 32-character hex string or base64-encoded (wrapping either the hex text or
 * the raw 16 bytes), and a server-provided `full_url` wins over one built from
 * `encrypt_query_param`.
 *
 * Outbound: the reverse, and the three traps that cost the reference
 * implementation six rounds of guessing:
 *   1. `aes_key` in the message item is base64 of the hex *text*, never of the
 *      raw bytes — the wrong form is accepted by the service and renders as a
 *      grey box on the phone;
 *   2. the download parameter comes from the `x-encrypted-param` response
 *      header of the upload, not from the upload URL itself;
 *   3. items carry the minimum fields: image = `media` + `mid_size`,
 *      file = `media` + `file_name` + `len`.
 *
 * A message whose attachment cannot be fetched is still worth delivering, so
 * inbound failures degrade to a note instead of an exception.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  CDN_BASE_URL,
  ItemType,
  UploadMediaType,
  fileItem,
  getUploadUrl,
  imageItem,
  isTrustedUrl,
  redactSecrets,
  videoItem,
  type MessageItem,
  type MediaRef,
  type UploadedMedia,
  type WeixinAccount,
} from "./ilink.ts"
import { STATE_DIR } from "./state.ts"

export interface DownloadedMedia {
  /** Local path the agent can read. */
  path: string
  name: string
  kind: "image" | "file" | "video" | "voice"
  bytes: number
}

export const INBOX_DIR = join(STATE_DIR, "inbox")

/** Download and decrypt one inbound attachment. Never throws. */
export async function downloadItem(params: {
  account: WeixinAccount
  item: MessageItem
  signal?: AbortSignal
}): Promise<{ media?: DownloadedMedia; note?: string }> {
  const { item } = params
  const descriptor = describe(item)
  if (!descriptor) return { note: "收到一条不支持的消息类型" }

  try {
    const raw = await fetchMedia({ ref: descriptor.ref, signal: params.signal })
    if (!raw) return { note: `${descriptor.name}：下载失败` }

    if (descriptor.expectsKey && !descriptor.key) {
      // Writing the ciphertext to a `.jpg` used to look like a successful
      // download and handed the model garbage; say what actually happened.
      return { note: `${descriptor.name}：附件密钥无法解析，已跳过` }
    }
    const plain = descriptor.key ? decryptAesEcb(raw, descriptor.key) : raw
    if (!plain) return { note: `${descriptor.name}：解密失败` }

    // A truncated body (portal page, NAT reset reported as EOF, hostile answer)
    // must not be passed off silently as the user's real attachment. The file is
    // still delivered — rejecting it would lose data if the declared size is
    // ever wrong — but the mismatch is reported.
    let sizeWarning: string | undefined
    if (descriptor.declared) {
      const actual = descriptor.declared.of === "cipher" ? raw.byteLength : plain.byteLength
      const slack = descriptor.declared.of === "cipher" ? 16 : 0
      if (Math.abs(actual - descriptor.declared.bytes) > slack) {
        sizeWarning = `${descriptor.name}：大小与声明不符（服务端说 ${descriptor.declared.bytes} 字节，收到 ${actual}），可能被截断`
      }
    }

    mkdirSync(INBOX_DIR, { recursive: true })
    const path = join(INBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeInboxName(descriptor.name)}`)
    // Private chat media: keep it as private as the credentials next to it.
    writeFileSync(path, plain, { mode: 0o600 })
    pruneInbox()
    return {
      media: { path, name: descriptor.name, kind: descriptor.kind, bytes: plain.byteLength },
      ...(sizeWarning === undefined ? {} : { note: sizeWarning }),
    }
  } catch (error) {
    return { note: `${descriptor.name}：${error instanceof Error ? error.message : String(error)}` }
  }
}

function describe(item: MessageItem):
  | {
      kind: DownloadedMedia["kind"]
      name: string
      ref?: MediaRef
      key?: Buffer
      expectsKey: boolean
      /** Size the server declared, so a truncated body is not passed off as the file. */
      declared?: { bytes: number; of: "cipher" | "plain" }
    }
  | undefined {
  if (item.type === ItemType.IMAGE && item.image_item?.media) {
    const media = item.image_item.media
    const mid = item.image_item.mid_size
    return {
      kind: "image",
      name: `image-${short(item.msg_id ?? String(Date.now()))}.jpg`,
      ref: media,
      // `aeskey` wins when it decodes, but a present-but-unusable one must not
      // stop us from trying the key carried by the media ref itself.
      key: decodeKey(item.image_item.aeskey) ?? decodeKey(media.aes_key),
      expectsKey: Boolean(item.image_item.aeskey?.trim() || media.aes_key?.trim()),
      // `mid_size` is the ciphertext size, which is what we download.
      ...(typeof mid === "number" && mid > 0 ? { declared: { bytes: mid, of: "cipher" as const } } : {}),
    }
  }
  if (item.type === ItemType.FILE && item.file_item?.media) {
    const media = item.file_item.media
    const len = Number(item.file_item.len ?? "")
    return {
      kind: "file",
      name: item.file_item.file_name?.trim() || `file-${short(item.msg_id ?? String(Date.now()))}.bin`,
      ref: media,
      key: decodeKey(media.aes_key),
      expectsKey: Boolean(media.aes_key?.trim()),
      ...(Number.isFinite(len) && len > 0 ? { declared: { bytes: len, of: "plain" as const } } : {}),
    }
  }
  if (item.type === ItemType.VIDEO && item.video_item?.media) {
    const media = item.video_item.media
    const size = item.video_item.video_size
    return {
      kind: "video",
      name: `video-${short(item.msg_id ?? String(Date.now()))}.mp4`,
      ref: media,
      key: decodeKey(media.aes_key),
      expectsKey: Boolean(media.aes_key?.trim()),
      ...(typeof size === "number" && size > 0 ? { declared: { bytes: size, of: "cipher" as const } } : {}),
    }
  }
  if (item.type === ItemType.VOICE && item.voice_item?.media) {
    const media = item.voice_item.media
    return {
      kind: "voice",
      name: `voice-${short(item.msg_id ?? String(Date.now()))}.silk`,
      ref: media,
      key: decodeKey(media.aes_key),
      expectsKey: Boolean(media.aes_key?.trim()),
    }
  }
  return undefined
}function short(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8)
}

/**
 * Make a server-supplied file name safe for the inbox.
 *
 * Separators and reserved characters are replaced (no traversal, no device
 * names), the length is capped so the full path stays under MAX_PATH on
 * Windows, and a trailing dot/space is stripped because Win32 silently drops
 * those — the path we hand to the model would then not exist.
 */
export function safeInboxName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "")
  const points = [...cleaned]
  const capped = points.length > 80 ? points.slice(0, 80).join("") : cleaned
  return capped || "attachment"
}

/** One download must not hold the inbound pump forever. */
const DOWNLOAD_TIMEOUT_MS = 60_000
/** Largest inbound attachment worth buffering; bigger ones are refused. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** Combine a caller signal with a deadline, without needing newer DOM types. */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const anySignals = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  const deadline = timeout ? timeout(ms) : undefined
  if (signal && deadline && anySignals) return anySignals([signal, deadline])
  if (deadline) return deadline
  if (signal) return signal
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  timer.unref?.()
  return controller.signal
}

/** Download one attachment, with a deadline and a hard size budget. */
export async function fetchMedia(params: {
  ref?: MediaRef
  signal?: AbortSignal
  /** Overridable for tests. */
  timeoutMs?: number
  /** Overridable for tests. */
  maxBytes?: number
}): Promise<Buffer | undefined> {
  const url = mediaUrl(params.ref)
  if (!url) return undefined
  // The URL comes from a `getupdates` answer, i.e. from the network. On Bun
  // `fetch("file://…")` reads local files, which would copy `state.json` (bot
  // token included) into the inbox and hand it to the model.
  if (!isTrustedUrl(url)) return undefined
  const maxBytes = params.maxBytes ?? MAX_DOWNLOAD_BYTES

  let response: Response
  try {
    response = await fetch(url, {
      signal: withDeadline(params.signal, params.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
      redirect: "follow",
    })
  } catch {
    // A timeout or a dropped connection means "could not download", which the
    // caller turns into a note; it must not look like a crash.
    return undefined
  }
  if (!response.ok) return undefined
  // A redirect may have left the trusted hosts — do not read that body.
  if (response.url && !isTrustedUrl(response.url)) return undefined

  const declared = Number(response.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > maxBytes) return undefined

  const reader = response.body?.getReader()
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    // An empty body is a failed download, not an empty attachment: writing it
    // would hand the model a 0-byte file presented as the user's real one.
    if (buffer.byteLength === 0) return undefined
    return buffer.byteLength > maxBytes ? undefined : buffer
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
      return undefined
    }
    chunks.push(Buffer.from(value))
  }
  const body = Buffer.concat(chunks)
  return body.byteLength === 0 ? undefined : body
}

export function mediaUrl(ref?: MediaRef): string | undefined {
  if (!ref) return undefined
  if (ref.full_url) return ref.full_url
  if (ref.encrypt_query_param) {
    return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(ref.encrypt_query_param)}`
  }
  return undefined
}

/** Accept a 32-char hex key, base64 of that hex text, or base64 of 16 raw bytes. */
export function decodeKey(value?: string): Buffer | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return Buffer.from(trimmed, "hex")

  try {
    const decoded = Buffer.from(trimmed, "base64")
    if (decoded.byteLength === 16) return decoded
    const asText = decoded.toString("utf8")
    if (/^[0-9a-fA-F]{32}$/.test(asText)) return Buffer.from(asText, "hex")
  } catch {
    // Fall through: an unusable key means the ciphertext is treated as plaintext.
  }
  return undefined
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer | undefined {
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return undefined
  }
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/** Ciphertext size after PKCS#7 padding to a 16-byte boundary. */
export function aesEcbPaddedSize(plainSize: number): number {
  return Math.ceil((plainSize + 1) / 16) * 16
}

/** Received attachments older than this are deleted on the next download. */
const INBOX_RETENTION_DAYS = 14
/** …and the inbox as a whole is capped, oldest first. */
const INBOX_MAX_BYTES = 512 * 1024 * 1024

/**
 * Keep the inbox bounded.
 *
 * Attachments are the user's own media, but nothing else ever removes them:
 * private files would stay on disk forever, and every local user could read
 * them. Retention is deliberately generous (two weeks, half a gigabyte).
 */
export function pruneInbox(now: number = Date.now()): number {
  let removed = 0
  try {
    const cutoff = now - INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const kept: { path: string; mtime: number; size: number }[] = []
    for (const name of readdirSync(INBOX_DIR)) {
      const path = join(INBOX_DIR, name)
      try {
        const stats = statSync(path)
        if (!stats.isFile()) continue
        if (stats.mtimeMs < cutoff) {
          rmSync(path, { force: true })
          removed += 1
          continue
        }
        kept.push({ path, mtime: stats.mtimeMs, size: stats.size })
      } catch {
        // A racing delete is fine.
      }
    }
    let total = kept.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of kept.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= INBOX_MAX_BYTES) break
      rmSync(entry.path, { force: true })
      total -= entry.size
      removed += 1
    }
  } catch {
    // No inbox yet.
  }
  return removed
}

/*
 * ---------------------------------------------------------------------------
 * Outbound
 * ---------------------------------------------------------------------------
 */

export type OutboundKind = "image" | "file" | "video"

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"])

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
}

export function kindForPath(path: string): OutboundKind {
  const extension = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return "image"
  if (VIDEO_EXTENSIONS.has(extension)) return "video"
  return "file"
}

export function mimeForPath(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? "application/octet-stream"
}

/** Largest attachment the service reliably accepts. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export interface OutboundAttachment {
  item: MessageItem
  kind: OutboundKind
  name: string
  plainSize: number
  cipherSize: number
}

/**
 * Upload one local file and build the message item that carries it.
 *
 * Throws with a readable reason: a file that cannot be sent is worth reporting
 * to the agent, which can then choose a different route.
 */
export async function prepareAttachment(params: {
  account: WeixinAccount
  filePath: string
  toUserId: string
  kind?: OutboundKind
  fileName?: string
  signal?: AbortSignal
}): Promise<OutboundAttachment> {
  const stats = statSync(params.filePath)
  if (!stats.isFile()) throw new Error(`不是文件：${params.filePath}`)
  if (stats.size === 0) throw new Error(`文件是空的：${params.filePath}`)
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(`文件太大（${(stats.size / 1024 / 1024).toFixed(1)}MB），上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`)
  }

  const plaintext = readFileSync(params.filePath)
  const kind = params.kind ?? kindForPath(params.filePath)
  const name = params.fileName ?? basename(params.filePath)

  const filekey = randomBytes(16).toString("hex")
  const aesKey = randomBytes(16)
  const plainSize = plaintext.byteLength
  const cipherSize = aesEcbPaddedSize(plainSize)
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex")

  const upload = await getUploadUrl({
    account: params.account,
    filekey,
    mediaType: kind === "image" ? UploadMediaType.IMAGE : kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE,
    toUserId: params.toUserId,
    rawsize: plainSize,
    rawfilemd5,
    filesize: cipherSize,
    aeskey: aesKey.toString("hex"),
    signal: params.signal,
  })

  const uploadFullUrl = upload.upload_full_url?.trim()
  const uploadParam = upload.upload_param
  if (!uploadFullUrl && !uploadParam) throw new Error("服务端没有返回上传地址")

  const downloadParam = await uploadCiphertext({
    buf: plaintext,
    aesKey,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    filekey,
    signal: params.signal,
    // Retries ask for a fresh single-use URL instead of replaying a spent one.
    renew: async () => {
      const fresh = await getUploadUrl({
        account: params.account,
        filekey,
        mediaType:
          kind === "image" ? UploadMediaType.IMAGE : kind === "video" ? UploadMediaType.VIDEO : UploadMediaType.FILE,
        toUserId: params.toUserId,
        rawsize: plainSize,
        rawfilemd5,
        filesize: cipherSize,
        aeskey: aesKey.toString("hex"),
        signal: params.signal,
      })
      const full = fresh.upload_full_url?.trim()
      if (full && isTrustedUrl(full)) return full
      return uploadUrlFromParam(fresh.upload_param, filekey)
    },
  })

  const uploaded: UploadedMedia = {
    downloadParam,
    aesKeyHex: aesKey.toString("hex"),
    plainSize,
    cipherSize,
  }

  const item =
    kind === "image" ? imageItem(uploaded) : kind === "video" ? videoItem(uploaded) : fileItem(uploaded, name)

  return { item, kind, name, plainSize, cipherSize }
}

const UPLOAD_ATTEMPTS = 3
/** One CDN upload attempt may take this long before it is aborted. */
const UPLOAD_TIMEOUT_MS = 180_000

/** Build the CDN upload URL from a single-use parameter. */
function uploadUrlFromParam(param: string | undefined, filekey: string): string | undefined {
  if (!param) return undefined
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(param)}&filekey=${encodeURIComponent(filekey)}`
}

/**
 * Make remote text safe to log and to forward: control characters stripped,
 * credential shapes redacted, length capped. The caller marks the provenance,
 * because a CDN error string is not something the bridge said.
 */
function sanitizeRemoteText(text: string, limit = 160): string {
  return redactSecrets(text.replace(/[\u0000-\u001f\u007f]/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

/** POST the ciphertext and read back the download parameter. */
async function uploadCiphertext(params: {
  buf: Buffer
  aesKey: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
  signal?: AbortSignal
  /** Ask the service for a fresh URL — the parameter is single-use. */
  renew?: () => Promise<string | undefined>
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buf, params.aesKey)
  let url = params.uploadFullUrl ?? uploadUrlFromParam(params.uploadParam, params.filekey)
  if (!url) throw new Error("缺少 CDN 上传地址")

  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        // A hung CDN connection used to hold the per-conversation send chain
        // forever, with nothing able to cancel it.
        signal: withDeadline(params.signal, UPLOAD_TIMEOUT_MS),
      })
      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers.get("x-error-message") ?? (await response.text()).slice(0, 200)
        throw new Error(`CDN 拒绝上传 ${response.status}${detail ? `：远端返回 ${sanitizeRemoteText(detail)}` : ""}`)
      }
      if (response.status !== 200) throw new Error(`CDN 上传失败：HTTP ${response.status}`)
      const downloadParam = response.headers.get("x-encrypted-param") ?? undefined
      if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param 头")
      return downloadParam
    } catch (error) {
      lastError = error
      // A 4xx is final: retrying the same request cannot help.
      if (error instanceof Error && error.message.startsWith("CDN 拒绝上传")) throw error
      // A cancelled upload must not be retried either.
      if (params.signal?.aborted) throw error
      if (attempt < UPLOAD_ATTEMPTS) {
        // The upload parameter is single-use, so a retry on the same URL often
        // cannot succeed (the first attempt reached the CDN and was lost).
        if (params.renew) {
          const fresh = await params.renew().catch(() => undefined)
          if (fresh) url = fresh
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("CDN 上传失败")
}
