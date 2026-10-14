/**
 * Integration tests against a mock iLink service.
 *
 * The WeChat backend cannot be exercised from CI, and it is the part where a
 * mistake is expensive: a wrong `aes_key` encoding is accepted by the service
 * and renders as a grey box on someone's phone. So the whole wire path is run
 * against a local server that implements the endpoints the way the official
 * docs describe them, and the assertions are on what actually went over the
 * wire.
 *
 *   bun test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createCipheriv, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { login, sendItems, sendText, imageItem, type WeixinAccount } from "../ilink.ts"
import { ChannelMonitor } from "../monitor.ts"
import { prepareAttachment } from "../media.ts"

interface Recorded {
  path: string
  body: Record<string, unknown>
  token?: string
  authorizationType?: string
  appId?: string
  uin?: string
}

interface MockState {
  requests: Recorded[]
  updates: Array<{ msgs: Array<Record<string, unknown>>; buf: string }>
  uploadedBytes?: Buffer
  uploadAesKeyHex?: string
  qrPolls: number
  sendRefusals: number
  /** Respond to `getupdates` with `errcode -14` (revoked token). */
  staleToken: boolean
  downloadBytes: Buffer
  downloadAesKey: Buffer
}

let server: Server
let baseUrl = ""
let state: MockState

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

beforeAll(async () => {
  state = {
    requests: [],
    updates: [],
    qrPolls: 0,
    sendRefusals: 0,
    staleToken: false,
    downloadBytes: Buffer.from("inbound-bytes"),
    downloadAesKey: randomBytes(16),
  }

  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const rawBytes = request.method === "POST" ? await readBody(request) : Buffer.alloc(0)
      const isJson = (request.headers["content-type"] ?? "").includes("json")
      const parsed = isJson && rawBytes.length > 0 ? (JSON.parse(rawBytes.toString("utf8")) as Record<string, unknown>) : {}

      state.requests.push({
        path: `${request.method} ${url.pathname}`,
        body: parsed,
        token: request.headers.authorization?.replace(/^Bearer /, ""),
        authorizationType: request.headers.authorizationtype as string | undefined,
        appId: request.headers["ilink-app-id"] as string | undefined,
        uin: request.headers["x-wechat-uin"] as string | undefined,
      })

      const json = (payload: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(200, { "content-type": "application/json", ...headers })
        response.end(JSON.stringify(payload))
      }

      switch (`${request.method} ${url.pathname}`) {
        case "POST /ilink/bot/get_bot_qrcode":
          json({ qrcode: "qr-handle-1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc" })
          return
        case "GET /ilink/bot/get_qrcode_status": {
          state.qrPolls += 1
          if (state.qrPolls === 1) json({ status: "wait" })
          else {
            json({
              status: "confirmed",
              bot_token: "token-1",
              ilink_bot_id: "bot@im.bot",
              ilink_user_id: "user@im.wechat",
              baseurl: baseUrl,
            })
          }
          return
        }
        case "POST /ilink/bot/getupdates": {
          if (state.staleToken) {
            json({ ret: 0, errcode: -14, errmsg: "session expired", longpolling_timeout_ms: 1_000 })
            return
          }
          const next = state.updates.shift()
          if (!next) {
            json({ ret: 0, msgs: [], get_updates_buf: "buf-idle", longpolling_timeout_ms: 1_000 })
            return
          }
          json({ ret: 0, msgs: next.msgs, get_updates_buf: next.buf, longpolling_timeout_ms: 1_000 })
          return
        }
        case "POST /ilink/bot/sendmessage": {
          if (state.sendRefusals > 0) {
            state.sendRefusals -= 1
            json({ ret: -2, errmsg: "prepare failed" })
            return
          }
          json({ ret: 0, message_id: "7514975623787282440" })
          return
        }
        case "POST /ilink/bot/getconfig":
          json({ ret: 0, typing_ticket: "ticket-1" })
          return
        case "POST /ilink/bot/sendtyping":
          json({ ret: 0 })
          return
        case "POST /ilink/bot/msg/notifystart":
        case "POST /ilink/bot/msg/notifystop":
          json({ ret: 0 })
          return
        case "POST /ilink/bot/getuploadurl": {
          state.uploadAesKeyHex = String(parsed.aeskey ?? "")
          json({
            ret: 0,
            upload_param: "upload-param-1",
            upload_full_url: `${baseUrl}/upload?encrypted_query_param=upload-param-1&filekey=${String(parsed.filekey ?? "")}`,
          })
          return
        }
        case "POST /upload": {
          state.uploadedBytes = Buffer.from(rawBytes)
          json({}, { "x-encrypted-param": "download-param-1" })
          return
        }
        case "GET /download": {
          // `createCipheriv` applies PKCS#7 itself; adding it here again would
          // leave the manual padding behind after decryption.
          const cipher = createCipheriv("aes-128-ecb", state.downloadAesKey, null)
          const ciphertext = Buffer.concat([cipher.update(state.downloadBytes), cipher.final()])
          response.writeHead(200, { "content-type": "application/octet-stream" })
          response.end(ciphertext)
          return
        }
        default:
          response.writeHead(404)
          response.end("nope")
      }
    })()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(() => {
  server.close()
})

describe("login", () => {
  test("completes the QR handshake and reports progress", async () => {
    const events: string[] = []
    const result = await login({
      baseUrl,
      existingTokens: ["old-token"],
      timeoutMs: 15_000,
      onEvent: (event) => events.push(event.kind),
    })

    expect(result.alreadyBound).toBe(false)
    expect(result.account?.accountId).toBe("bot@im.bot")
    expect(result.account?.token).toBe("token-1")
    expect(result.account?.userId).toBe("user@im.wechat")
    // The service hands back the IDC host it wants to be polled on.
    expect(result.account?.baseUrl).toBe(baseUrl)
    expect(events).toContain("qr")
    expect(events).toContain("confirmed")

    // Existing tokens must be offered so the server can reuse the binding
    // instead of silently creating a second bot identity.
    const qrRequest = state.requests.find((entry) => entry.path === "POST /ilink/bot/get_bot_qrcode")
    expect(qrRequest?.body.local_token_list).toEqual(["old-token"])
    expect(qrRequest?.appId).toBe("bot")
    expect(qrRequest?.uin).toBeString()
  })
})

describe("monitor", () => {
  test("receives messages, persists the cursor before dispatch, and stops on abort", async () => {
    const account: WeixinAccount = {
      accountId: "bot@im.bot",
      token: "token-1",
      baseUrl,
      userId: "user@im.wechat",
    }

    state.updates = [
      {
        buf: "cursor-1",
        msgs: [
          {
            message_id: "111111111111111111",
            from_user_id: "user@im.wechat",
            message_type: 1,
            context_token: "ctx-1",
            item_list: [{ type: 1, text_item: { text: "你好" } }],
          },
          {
            message_id: "222222222222222222",
            from_user_id: "user@im.wechat",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "带附件" } }, { type: 2, image_item: { mid_size: 32, media: { encrypt_query_param: "p" } } }],
          },
          // The bot's own echo must never come back as an inbound prompt.
          {
            message_id: "333333333333333333",
            from_user_id: "bot@im.bot",
            message_type: 2,
            item_list: [{ type: 1, text_item: { text: "我发的" } }],
          },
        ],
      },
    ]

    const received: Array<{ text: string; media: number; id?: string; context?: string }> = []
    const cursors: string[] = []
    const controller = new AbortController()

    const monitor = new ChannelMonitor({
      account,
      onMessage: async (message) => {
        received.push({
          text: message.text,
          media: message.media?.length ?? 0,
          id: message.messageId,
          context: message.contextToken,
        })
        if (received.length >= 2) controller.abort()
      },
      onSyncBuf: (buf) => {
        cursors.push(buf)
      },
    })

    const reason = await monitor.run(controller.signal)
    expect(reason).toBe("aborted")
    expect(received.map((entry) => entry.text)).toEqual(["你好", "带附件"])
    expect(received[1].media).toBe(1)
    expect(received[0].context).toBe("ctx-1")
    // Ids are strings, never numbers that could be rounded.
    expect(received[0].id).toBe("111111111111111111")
    expect(cursors).toEqual(["cursor-1"])
  })

  test("stops itself when it no longer owns the poller slot", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    let owned = false
    const monitor = new ChannelMonitor({
      account,
      onMessage: async () => {},
      shouldContinue: () => owned,
      onStop: (reason, detail) => {
        expect(reason).toBe("aborted")
        expect(detail).toContain("轮询锁")
      },
    })
    expect(await monitor.run(new AbortController().signal)).toBe("aborted")
  })

  test("treats a stale token as a stop, not a retry loop", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    state.updates = []
    state.staleToken = true
    const stops: Array<{ reason: string; detail?: string }> = []
    try {
      const monitor = new ChannelMonitor({
        account,
        onMessage: async () => {},
        onStop: (reason, detail) => {
          stops.push({ reason, detail })
        },
      })
      // `errcode -14` means the bot token is gone: the loop must stop and say so,
      // because retrying is pointless until the user scans a new QR code.
      expect(await monitor.run(new AbortController().signal)).toBe("stale-token")
      expect(stops).toHaveLength(1)
      expect(stops[0].reason).toBe("stale-token")
      expect(stops[0].detail).toContain("token")
    } finally {
      state.staleToken = false
    }
  })
})

describe("sending", () => {
  test("text carries the documented shape", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    state.requests.length = 0
    const result = await sendText({ account, to: "user@im.wechat", text: "hello", contextToken: "ctx-1" })

    expect(result.serverMessageId).toBe("7514975623787282440")
    const sent = state.requests.find((entry) => entry.path === "POST /ilink/bot/sendmessage")
    const msg = sent?.body.msg as Record<string, unknown>
    expect(msg.to_user_id).toBe("user@im.wechat")
    expect(msg.from_user_id).toBe("")
    expect(msg.message_type).toBe(2)
    expect(msg.message_state).toBe(2)
    expect(msg.context_token).toBe("ctx-1")
    expect(String(msg.client_id)).toMatch(/^opencode-wechat:\d+-[0-9a-f]{8}$/)
    expect((msg.item_list as Array<Record<string, unknown>>)[0]).toEqual({
      type: 1,
      text_item: { text: "hello" },
    })
    expect(sent?.token).toBe("token-1")
    expect(sent?.authorizationType).toBe("ilink_bot_token")
  })

  test("a refusal surfaces instead of looking like a delivery", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    state.sendRefusals = 1
    await expect(sendText({ account, to: "user@im.wechat", text: "x" })).rejects.toThrow(/prepare failed/)
  })
})

describe("outbound media", () => {
  const workdir = mkdtempSync(join(tmpdir(), "wechat-test-"))

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  test("encrypts, uploads, and describes the attachment the way the service expects", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    const filePath = join(workdir, "hello.png")
    const content = Buffer.from("not-really-a-png-but-that-is-fine")
    writeFileSync(filePath, content)

    state.requests.length = 0
    const attachment = await prepareAttachment({ account, filePath, toUserId: "user@im.wechat", kind: "image" })

    // getuploadurl must carry the padded size and the plaintext hash.
    const padded = Math.ceil((content.length + 1) / 16) * 16
    const uploadRequest = state.requests.find((entry) => entry.path === "POST /ilink/bot/getuploadurl")
    expect(uploadRequest?.body.rawsize).toBe(content.length)
    expect(uploadRequest?.body.filesize).toBe(padded)
    expect(uploadRequest?.body.no_need_thumb).toBe(true)
    expect(uploadRequest?.body.media_type).toBe(1)

    // The CDN must have received the ciphertext, not the plaintext.
    expect(state.uploadedBytes?.byteLength).toBe(padded)
    expect(state.uploadedBytes?.equals(content)).toBe(false)

    // ...and it must decrypt back with the key the service was told about.
    const key = Buffer.from(String(state.uploadAesKeyHex), "hex")
    const { createDecipheriv } = await import("node:crypto")
    const decipher = createDecipheriv("aes-128-ecb", key, null)
    const plain = Buffer.concat([decipher.update(state.uploadedBytes!), decipher.final()])
    expect(plain.equals(content)).toBe(true)

    // The item is minimal: image carries `media` + `mid_size` and nothing else.
    expect(attachment.item.type).toBe(2)
    expect(attachment.item.image_item?.mid_size).toBe(padded)
    expect(attachment.item.image_item?.media?.encrypt_query_param).toBe("download-param-1")
    expect(Buffer.from(attachment.item.image_item!.media!.aes_key!, "base64").toString("utf8")).toBe(
      String(state.uploadAesKeyHex),
    )
    expect(attachment.item.image_item?.media?.encrypt_type).toBe(1)

    // Sending it produces one request per item.
    state.requests.length = 0
    await sendItems({ account, to: "user@im.wechat", items: [attachment.item] })
    const sends = state.requests.filter((entry) => entry.path === "POST /ilink/bot/sendmessage")
    expect(sends.length).toBe(1)
    expect(sends[0].body.msg).toMatchObject({ to_user_id: "user@im.wechat", message_type: 2 })
  })

  test("a non-image goes out as a file card with the plaintext length", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    const filePath = join(workdir, "report.pdf")
    writeFileSync(filePath, Buffer.from("pdf-bytes"))

    const attachment = await prepareAttachment({ account, filePath, toUserId: "user@im.wechat" })
    expect(attachment.item.type).toBe(4)
    expect(attachment.item.file_item?.file_name).toBe("report.pdf")
    expect(attachment.item.file_item?.len).toBe("9")
  })

  test("refuses obviously unsendable files with a readable reason", async () => {
    const account: WeixinAccount = { accountId: "bot@im.bot", token: "token-1", baseUrl }
    await expect(
      prepareAttachment({ account, filePath: join(workdir, "missing.png"), toUserId: "user@im.wechat" }),
    ).rejects.toThrow(/ENOENT|no such file|不是文件/)
  })

  test("image items built by hand keep the key encoding", () => {
    const item = imageItem({
      downloadParam: "p",
      aesKeyHex: "aa".repeat(16),
      plainSize: 3,
      cipherSize: 16,
    })
    expect(Buffer.from(item.image_item!.media!.aes_key!, "base64").toString("utf8")).toBe("aa".repeat(16))
  })

  test("downloads and decrypts an inbound image into the inbox", async () => {
    const { downloadItem } = await import("../media.ts")
    const item = {
      type: 2,
      msg_id: "999999999999",
      image_item: {
        aeskey: state.downloadAesKey.toString("hex"),
        mid_size: 64,
        media: { full_url: `${baseUrl}/download`, encrypt_type: 1 },
      },
    }

    const result = await downloadItem({ account: { accountId: "bot@im.bot", token: "t", baseUrl }, item })
    expect(result.note).toBeUndefined()
    expect(result.media?.bytes).toBe(state.downloadBytes.byteLength)
    expect(readFileSync(result.media!.path).equals(state.downloadBytes)).toBe(true)
    expect(result.media?.kind).toBe("image")
    rmSync(result.media!.path, { force: true })
  })

  test("an attachment it cannot fetch becomes a note, not an exception", async () => {
    const { downloadItem } = await import("../media.ts")
    const result = await downloadItem({
      account: { accountId: "bot@im.bot", token: "t", baseUrl },
      item: { type: 4, file_item: { file_name: "x.zip", media: { full_url: `${baseUrl}/missing` } } },
    })
    expect(result.media).toBeUndefined()
    expect(result.note).toContain("x.zip")
  })
})

/**
 * The local OpenCode API is what makes `/list` and `/answer` work, and it is
 * reached with a hand-built Basic header, so the shape is worth pinning.
 */
describe("local api", () => {
  let apiServer: Server
  let apiUrl = ""
  let sawAuth: string | undefined
  let registrationFile = ""
  // Whatever the preload set (or nothing): put it back exactly. bun runs every
  // test file in one process and bridge.test.ts reads the variable at import
  // time, so a `delete` here can break a suite that loads later.
  const previousServiceFile = process.env.WECHAT_SERVICE_FILE
  let replyCount = 0

  beforeAll(async () => {
    apiServer = createServer((request, response) => {
      sawAuth = request.headers.authorization
      const url = new URL(request.url ?? "/", "http://127.0.0.1")

      if (url.pathname === "/api/info") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ version: "2.0.26", pid: 1 }))
        return
      }

      // Mutating endpoints answer 204 with no body, exactly like the real
      // service; treating that as a failure made a submitted form look rejected.
      if (url.pathname.endsWith("/reply") && request.method === "POST") {
        replyCount += 1
        if (replyCount === 1) {
          response.writeHead(204)
          response.end()
          return
        }
        response.writeHead(500, { "content-type": "application/json" })
        response.end(JSON.stringify({ _tag: "UnknownError", message: "boom" }))
        return
      }

      if (url.pathname === "/api/session") {
        if (sawAuth === undefined) {
          response.writeHead(401, { "content-type": "application/json" })
          response.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }))
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            data: [
              { id: "ses_aaaaaaaaaaaaaaaaaaaaaa1", title: "修复登录", location: { directory: "D:\\code\\app" } },
              { id: "ses_aaaaaaaaaaaaaaaaaaaaaa2", title: "写文档" },
            ],
          }),
        )
        return
      }

      if (url.pathname === "/api/session/ses_aaaaaaaaaaaaaaaaaaaaaa1/form") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            data: [
              {
                id: "frm_1",
                sessionID: "ses_aaaaaaaaaaaaaaaaaaaaaa1",
                title: "选一个",
                fields: [{ key: "pm", type: "string", options: [{ value: "pnpm", label: "pnpm" }] }],
                state: { status: "pending" },
              },
            ],
          }),
        )
        return
      }

      if (url.pathname.endsWith("/reply")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({}))
        return
      }

      response.writeHead(404)
      response.end("{}")
    })

    await new Promise<void>((resolve) => {
      apiServer.listen(0, "127.0.0.1", () => {
        const address = apiServer.address()
        const port = typeof address === "object" && address ? address.port : 0
        apiUrl = `http://127.0.0.1:${port}`
        resolve()
      })
    })

    const dir = mkdtempSync(join(tmpdir(), "wechat-api-"))
    registrationFile = join(dir, "service.json")
    writeFileSync(registrationFile, JSON.stringify({ url: apiUrl, pid: process.pid, password: "secret" }))
    process.env.WECHAT_SERVICE_FILE = registrationFile
  })

  afterAll(() => {
    apiServer.close()
    if (previousServiceFile === undefined) delete process.env.WECHAT_SERVICE_FILE
    else process.env.WECHAT_SERVICE_FILE = previousServiceFile
    rmSync(registrationFile, { force: true })
  })

  test("authenticates with Basic opencode:<password> and lists sessions", async () => {
    const { LocalApi } = await import("../api.ts")
    const api = new LocalApi({ cacheMs: 0 })
    const sessions = await api.listSessions({ limit: 5 })
    expect(sessions.map((session) => session.title)).toEqual(["修复登录", "写文档"])
    expect(sawAuth).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
    expect(api.isSelf).toBe(true)
  })

  test("reads and answers forms", async () => {
    const { LocalApi } = await import("../api.ts")
    const api = new LocalApi({ cacheMs: 0 })
    const forms = await api.listForms("ses_aaaaaaaaaaaaaaaaaaaaaa1")
    expect(forms[0]?.id).toBe("frm_1")
    // A 204 with no body is a success, not a failure.
    expect(await api.replyForm("ses_aaaaaaaaaaaaaaaaaaaaaa1", "frm_1", { pm: "pnpm" })).toBe(true)
    // A 500 is a failure.
    expect(await api.replyForm("ses_aaaaaaaaaaaaaaaaaaaaaa1", "frm_1", { pm: "pnpm" })).toBe(false)
  })

  test("an unreachable service degrades instead of throwing", async () => {
    process.env.WECHAT_SERVICE_FILE = join(tmpdir(), "definitely-missing-service.json")
    const { LocalApi } = await import("../api.ts")
    const api = new LocalApi({ cacheMs: 0, timeoutMs: 300 })
    expect(await api.listSessions()).toEqual([])
    expect(await api.info()).toBeUndefined()
    expect(api.available).toBe(false)
    process.env.WECHAT_SERVICE_FILE = registrationFile
  })
})
