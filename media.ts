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
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  CDN_BASE_URL,
  ItemType,
  UploadMediaType,
  fileItem,
  getUploadUrl,
  imageItem,
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

const INBOX_DIR = join(STATE_DIR, "inbox")

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

    const plain = descriptor.key ? decryptAesEcb(raw, descriptor.key) : raw
    if (!plain) return { note: `${descriptor.name}：解密失败` }

    mkdirSync(INBOX_DIR, { recursive: true })
    const safe = descriptor.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120)
    const path = join(INBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}`)
    writeFileSync(path, plain)
    return { media: { path, name: descriptor.name, kind: descriptor.kind, bytes: plain.byteLength } }
  } catch (error) {
    return { note: `${descriptor.name}：${error instanceof Error ? error.message : String(error)}` }
  }
}

function describe(item: MessageItem):
  | { kind: DownloadedMedia["kind"]; name: string; ref?: MediaRef; key?: Buffer }
  | undefined {
  if (item.type === ItemType.IMAGE && item.image_item?.media) {
    return {
      kind: "image",
      name: `image-${short(item.msg_id ?? String(Date.now()))}.jpg`,
      ref: item.image_item.media,
      key: decodeKey(item.image_item.aeskey ?? item.image_item.media.aes_key),
    }
  }
  if (item.type === ItemType.FILE && item.file_item?.media) {
    return {
      kind: "file",
      name: item.file_item.file_name?.trim() || `file-${short(item.msg_id ?? String(Date.now()))}.bin`,
      ref: item.file_item.media,
      key: decodeKey(item.file_item.media.aes_key),
    }
  }
  if (item.type === ItemType.VIDEO && item.video_item?.media) {
    return {
      kind: "video",
      name: `video-${short(item.msg_id ?? String(Date.now()))}.mp4`,
      ref: item.video_item.media,
      key: decodeKey(item.video_item.media.aes_key),
    }
  }
  if (item.type === ItemType.VOICE && item.voice_item?.media) {
    return {
      kind: "voice",
      name: `voice-${short(item.msg_id ?? String(Date.now()))}.silk`,
      ref: item.voice_item.media,
      key: decodeKey(item.voice_item.media.aes_key),
    }
  }
  return undefined
}

function short(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8)
}

/** Prefer the server-provided full URL, otherwise build one from the download param. */
export async function fetchMedia(params: { ref?: MediaRef; signal?: AbortSignal }): Promise<Buffer | undefined> {
  const url = mediaUrl(params.ref)
  if (!url) return undefined
  const response = await fetch(url, { signal: params.signal })
  if (!response.ok) return undefined
  return Buffer.from(await response.arrayBuffer())
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

/** POST the ciphertext and read back the download parameter. */
async function uploadCiphertext(params: {
  buf: Buffer
  aesKey: Buffer
  uploadFullUrl?: string
  uploadParam?: string
  filekey: string
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buf, params.aesKey)
  const url =
    params.uploadFullUrl ??
    (params.uploadParam
      ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`
      : undefined)
  if (!url) throw new Error("缺少 CDN 上传地址")

  let lastError: unknown
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      })
      if (response.status >= 400 && response.status < 500) {
        const detail = response.headers.get("x-error-message") ?? (await response.text()).slice(0, 200)
        throw new Error(`CDN 拒绝上传 ${response.status}：${detail}`)
      }
      if (response.status !== 200) throw new Error(`CDN 上传失败：HTTP ${response.status}`)
      const downloadParam = response.headers.get("x-encrypted-param") ?? undefined
      if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param 头")
      return downloadParam
    } catch (error) {
      lastError = error
      // A 4xx is final: retrying the same request cannot help.
      if (error instanceof Error && error.message.startsWith("CDN 拒绝上传")) throw error
      if (attempt < UPLOAD_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw lastError instanceof Error ? lastError : new Error("CDN 上传失败")
}
