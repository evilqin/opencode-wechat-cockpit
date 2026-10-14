/**
 * Pure-logic tests.
 *
 * Everything here is deliberately free of I/O: these are the rules that decide
 * what the bridge does with a message, and they are the parts most likely to
 * break silently when the wire protocol or the phone's expectations change.
 *
 *   bun test
 */

import { describe, expect, test } from "bun:test"

import { chunkText, isResumeGap, numberChunks, renderForWechat } from "../bridge.ts"
import { aesEcbPaddedSize, decodeKey, decryptAesEcb, encryptAesEcb, kindForPath, mimeForPath } from "../media.ts"
import { normalizeConfig, configChanged, DEFAULT_CONFIG } from "../config.ts"
import { parseDecision, parseSelector } from "../permissions.ts"
import { resolveAnswer, type PendingForm } from "../forms.ts"
import {
  resolveAgentTarget,
  resolveModelTarget,
  resolveSessionTarget,
  titleFromText,
  unwrapData,
  unwrapList,
} from "../sessions.ts"
import { ChannelMonitor, conversationKey } from "../monitor.ts"
import {
  MAX_TEXT_CHARS,
  buildMediaRef,
  parseWireJson,
  newClientId,
  assertSendAccepted,
  sendText,
  sleep,
  SendRefusedError,
} from "../ilink.ts"
import { MAX_DOWNLOAD_BYTES, fetchMedia, pruneInbox } from "../media.ts"
import { LOCK_PATH, STATE_DIR, STATE_PATH, acquireLock, ensureStateDir, pruneStaleTemps, readState } from "../state.ts"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

describe("chunkText", () => {
  test("keeps short text intact", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"])
  })

  test("drops empty input", () => {
    expect(chunkText("   \n  ", 100)).toEqual([])
  })

  test("splits long text and loses nothing", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index} with some content`)
    const text = lines.join("\n")
    const chunks = chunkText(text, 300)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 320)).toBe(true)
    // Re-joining must reproduce every line, in order.
    const rejoined = chunks.join("\n").split("\n").filter((line) => !line.startsWith("```"))
    expect(rejoined).toEqual(lines)
  })

  test("hard-splits a single line that is longer than the limit", () => {
    // A minified blob or a paragraph with no spaces cannot be split on a line
    // boundary; without a hard cut the whole thing goes out as one oversized
    // message and the phone loses its tail.
    const line = "x".repeat(1000)
    const chunks = chunkText(line, 300)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true)
    expect(chunks.join("").replace(/\n/g, "")).toBe(line)
  })

  test("prefers a break near the cut", () => {
    const text = `${"a".repeat(250)} ${"b".repeat(250)}`
    const chunks = chunkText(text, 300)
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true)
    expect(chunks[0]!.endsWith(" ")).toBe(true)
  })

  test("closes and reopens code fences when splitting inside one", () => {
    const body = Array.from({ length: 60 }, (_, index) => `const x${index} = ${index}`).join("\n")
    const text = ["before", "```ts", body, "```", "after"].join("\n")
    const chunks = chunkText(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      const fences = chunk.split("\n").filter((line) => line.trim().startsWith("```")).length
      expect(fences % 2).toBe(0)
    }
  })
})

describe("numberChunks", () => {
  test("leaves a single part alone", () => {
    expect(numberChunks(["only"])).toEqual(["only"])
  })

  test("numbers every part of a multi-part reply", () => {
    expect(numberChunks(["a", "b", "c"])).toEqual(["（1/3）\na", "（2/3）\nb", "（3/3）\nc"])
  })
})

describe("renderForWechat", () => {
  test("strips ANSI escapes", () => {
    expect(renderForWechat("\u001B[31mred\u001B[0m")).toBe("red")
  })

  test("collapses runs of blank lines", () => {
    expect(renderForWechat("a\n\n\n\n\nb")).toBe("a\n\nb")
  })

  test("normalizes CRLF", () => {
    expect(renderForWechat("a\r\nb")).toBe("a\nb")
  })
})

describe("media", () => {
  test("padded size rounds up to the AES block", () => {
    expect(aesEcbPaddedSize(0)).toBe(16)
    expect(aesEcbPaddedSize(15)).toBe(16)
    expect(aesEcbPaddedSize(16)).toBe(32)
    expect(aesEcbPaddedSize(17)).toBe(32)
  })

  test("encrypt then decrypt returns the original", () => {
    const key = randomBytes(16)
    const plain = Buffer.from("hello 微信", "utf8")
    const cipher = encryptAesEcb(plain, key)
    expect(cipher.byteLength).toBe(aesEcbPaddedSize(plain.byteLength))
    expect(decryptAesEcb(cipher, key)?.toString("utf8")).toBe("hello 微信")
  })

  test("decodeKey accepts hex, base64-of-hex and base64-of-raw", () => {
    const key = randomBytes(16)
    const hex = key.toString("hex")
    expect(decodeKey(hex)?.toString("hex")).toBe(hex)
    expect(decodeKey(Buffer.from(hex, "utf8").toString("base64"))?.toString("hex")).toBe(hex)
    expect(decodeKey(key.toString("base64"))?.toString("hex")).toBe(hex)
    expect(decodeKey("not-a-key")).toBeUndefined()
    expect(decodeKey(undefined)).toBeUndefined()
  })

  test("media reference encodes the key as base64 of the hex text", () => {
    const ref = buildMediaRef({ downloadParam: "param", aesKeyHex: "0f1e2d", plainSize: 3, cipherSize: 16 })
    expect(ref.encrypt_query_param).toBe("param")
    expect(ref.encrypt_type).toBe(1)
    expect(Buffer.from(ref.aes_key!, "base64").toString("utf8")).toBe("0f1e2d")
  })

  test("kind follows the extension", () => {
    expect(kindForPath("a.png")).toBe("image")
    expect(kindForPath("a.MP4")).toBe("video")
    expect(kindForPath("a.pdf")).toBe("file")
    expect(mimeForPath("a.png")).toBe("image/png")
    expect(mimeForPath("a.unknown")).toBe("application/octet-stream")
  })
})

describe("config", () => {
  test("missing values fall back to defaults", () => {
    const config = normalizeConfig(undefined)
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  test("rejects nonsense without throwing", () => {
    const config = normalizeConfig({ chunkSize: -5, listLimit: 0, stream: "yes" as never, sendDelayMs: -1 })
    expect(config.chunkSize).toBe(DEFAULT_CONFIG.chunkSize)
    expect(config.listLimit).toBe(DEFAULT_CONFIG.listLimit)
    expect(config.stream).toBe("off")
    // Negative values fall back to the default rather than being clamped, so a
    // typo cannot silently turn pacing off.
    expect(config.sendDelayMs).toBe(DEFAULT_CONFIG.sendDelayMs)
    // An explicit zero is honoured: "no delay" is a legitimate choice.
    expect(normalizeConfig({ sendDelayMs: 0 }).sendDelayMs).toBe(0)
  })

  test("keeps explicit choices", () => {
    const config = normalizeConfig({ stream: "live", streamIntervalMs: 3_000, allowedUsers: ["a@im.wechat", ""] })
    expect(config.stream).toBe("live")
    expect(config.streamIntervalMs).toBe(3_000)
    expect(config.allowedUsers).toEqual(["a@im.wechat"])
  })

  test("changed detects edits", () => {
    const base = normalizeConfig(undefined)
    expect(configChanged(base, { ...base })).toBe(false)
    expect(configChanged(base, { ...base, progress: "off" })).toBe(true)
  })
})

describe("permission decisions", () => {
  test("accepts the documented shortcuts", () => {
    expect(parseDecision("1")).toBe("once")
    expect(parseDecision("2")).toBe("always")
    expect(parseDecision("3")).toBe("reject")
    expect(parseDecision("允许")).toBe("once")
    expect(parseDecision("拒绝！")).toBe("reject")
    expect(parseDecision("yes")).toBe("once")
  })

  test("does not hijack an ordinary instruction", () => {
    expect(parseDecision("1 加 1 等于几")).toBeUndefined()
    expect(parseDecision("帮我改一下配置")).toBeUndefined()
    expect(parseDecision("3 个文件都没了")).toBeUndefined()
  })

  test("selector understands indexes and all", () => {
    expect(parseSelector("2")).toEqual({ index: 2, all: false })
    expect(parseSelector("all")).toEqual({ all: true })
    expect(parseSelector("全部")).toEqual({ all: true })
    expect(parseSelector("")).toEqual({ all: false })
  })
})

describe("form answers", () => {
  const form = (fields: PendingForm["fields"]): PendingForm => ({
    conversationId: "c",
    sessionID: "ses",
    formID: "frm",
    title: "t",
    fields,
    createdAt: 0,
  })

  test("single choice by option number", () => {
    const target = form([
      { key: "pm", type: "string", options: [{ value: "pnpm", label: "pnpm" }, { value: "npm", label: "npm" }] },
    ])
    const result = resolveAnswer(target, "2")
    expect("answer" in result && result.answer).toEqual({ pm: "npm" })
  })

  test("single free text", () => {
    const result = resolveAnswer(form([{ key: "name", type: "string" }]), "  my-project  ")
    expect("answer" in result && result.answer).toEqual({ name: "my-project" })
  })

  test("several fields by number", () => {
    const target = form([
      { key: "pm", type: "string", options: [{ value: "pnpm", label: "pnpm" }] },
      { key: "tests", type: "boolean" },
    ])
    const result = resolveAnswer(target, "1=1; 2=是")
    expect("answer" in result && result.answer).toEqual({ pm: "pnpm", tests: true })
  })

  test("booleans, numbers and multiselect", () => {
    expect(resolveAnswer(form([{ key: "b", type: "boolean" }]), "no")).toEqual({ answer: { b: false }, summary: "b=否" })
    expect(resolveAnswer(form([{ key: "n", type: "integer" }]), "42")).toEqual({ answer: { n: 42 }, summary: "n=42" })
    const multi = form([
      {
        key: "files",
        type: "multiselect",
        options: [{ value: "a.ts", label: "a.ts" }, { value: "b.ts", label: "b.ts" }],
      },
    ])
    expect(resolveAnswer(multi, "1,2")).toEqual({ answer: { files: ["a.ts", "b.ts"] }, summary: "files=a.ts, b.ts" })
  })

  test("rejects impossible answers instead of guessing", () => {
    expect(resolveAnswer(form([{ key: "n", type: "number" }]), "abc")).toHaveProperty("error")
    expect(resolveAnswer(form([{ key: "a", type: "string" }, { key: "b", type: "string" }]), "only-one")).toHaveProperty(
      "error",
    )
    expect(resolveAnswer(form([{ key: "x", type: "external" }]), "1")).toHaveProperty("error")
    expect(resolveAnswer(form([{ key: "s", type: "string", options: [{ value: "x", label: "x" }] }]), "9")).toHaveProperty(
      "error",
    )
  })

  /**
   * Full-width punctuation is what a Chinese keyboard produces by default, and
   * `parseInt` on a mixed string once turned "1=2；2=是" into a silent half
   * answer that the service rejected with a misleading message.
   */
  test("accepts full-width separators", () => {
    const target = form([
      { key: "manager", type: "string", options: [{ value: "pnpm", label: "pnpm" }, { value: "npm", label: "npm" }] },
      { key: "runTests", type: "boolean" },
    ])
    const result = resolveAnswer(target, "1=2；2=是")
    expect("answer" in result && result.answer).toEqual({ manager: "npm", runTests: true })
    expect("answer" in result && result.summary).toContain("npm")
  })

  test("only a bare number counts as an option index", () => {
    const target = form([
      { key: "manager", type: "string", options: [{ value: "pnpm", label: "pnpm" }, { value: "npm", label: "npm" }] },
    ])
    // "2；2=是" is not a number, so it must be reported rather than resolved.
    expect(resolveAnswer(target, "2；2=是")).toHaveProperty("error")
    expect(resolveAnswer(target, "2")).toEqual({ answer: { manager: "npm" }, summary: "manager=npm" })
  })

  test("refuses a partial answer to a form with required questions", () => {
    const target = form([
      { key: "manager", type: "string", title: "用哪个包管理器？", required: true, options: [{ value: "npm", label: "npm" }] },
      { key: "runTests", type: "boolean", title: "要不要跑测试？", required: true },
    ])
    const result = resolveAnswer(target, "1=1")
    expect("error" in result && result.error).toContain("要不要跑测试？")
  })
})

describe("session presentation", () => {
  const sessions = [
    { id: "ses_aaaaaaaaaaaaaaaaaaaaaa1", title: "修复登录", location: { directory: "D:\\code\\app" }, time: { updated: Date.now() } },
    { id: "ses_aaaaaaaaaaaaaaaaaaaaaa2", title: "写文档", location: { directory: "D:\\code\\docs" } },
  ]

  test("resolves by index, suffix, id and unique title", () => {
    expect(resolveSessionTarget(sessions, "2")?.id).toBe(sessions[1].id)
    expect(resolveSessionTarget(sessions, "aa2")?.id).toBe(sessions[1].id)
    expect(resolveSessionTarget(sessions, sessions[0].id)?.id).toBe(sessions[0].id)
    expect(resolveSessionTarget(sessions, "文档")?.id).toBe(sessions[1].id)
    expect(resolveSessionTarget(sessions, "3")).toBeUndefined()
    expect(resolveSessionTarget(sessions, "不存在")).toBeUndefined()
  })

  test("resolves models by index, ref and unique name", () => {
    const models = [
      { providerID: "opencode-go", id: "fast" },
      { providerID: "anthropic", id: "claude-sonnet-4-5" },
    ]
    expect(resolveModelTarget(models, "2")?.id).toBe("claude-sonnet-4-5")
    expect(resolveModelTarget(models, "anthropic/claude-sonnet-4-5")?.providerID).toBe("anthropic")
    expect(resolveModelTarget(models, "sonnet")?.id).toBe("claude-sonnet-4-5")
    expect(resolveModelTarget(models, "9")).toBeUndefined()
  })

  test("resolves agents by index and id, hiding subagents", () => {
    const agents = [
      { id: "build", name: "Build" },
      { id: "helper", name: "Helper", mode: "subagent" },
    ]
    expect(resolveAgentTarget(agents, "1")?.id).toBe("build")
    expect(resolveAgentTarget(agents, "2")).toBeUndefined()
    expect(resolveAgentTarget(agents, "build")?.id).toBe("build")
  })

  test("titles come from the first meaningful line", () => {
    expect(titleFromText("\n\n## 修复登录流程\n细节")).toBe("修复登录流程")
    expect(titleFromText("```code```")).toBe("code")
    expect(titleFromText("   ")).toBeUndefined()
    expect(titleFromText("x".repeat(100))?.length).toBe(40)
  })

  /**
   * The plugin context is not uniform, and the difference is invisible until a
   * phone somewhere shows an empty list: `model.list`, `model.default` and
   * `agent.list` answer with `{ location, data }`, while `session.create` and
   * `session.get` answer with the value itself. Both shapes are pinned here.
   */
  test("unwrap handles the wrapped list shape", () => {
    expect(unwrapList({ location: { directory: "D:\\code" }, data: [{ id: "a" }, { id: "b" }] })).toEqual([
      { id: "a" },
      { id: "b" },
    ])
  })

  test("unwrap also handles a bare array and a bare value", () => {
    expect(unwrapList([{ id: "a" }])).toEqual([{ id: "a" }])
    expect(unwrapData<{ providerID: string; modelID: string }>({ providerID: "opencode-go", modelID: "fast" })).toEqual({
      providerID: "opencode-go",
      modelID: "fast",
    })
  })

  test("unwrap never throws on the shapes that mean 'nothing here'", () => {
    expect(unwrapList(undefined)).toEqual([])
    expect(unwrapList(null)).toEqual([])
    expect(unwrapList({ location: { directory: "x" }, data: null })).toEqual([])
    expect(unwrapData(null)).toBeUndefined()
  })
})

describe("wire format", () => {
  test("uint64 ids keep their digits", () => {
    const raw = '{"message_id":7514975623787282440,"msg_id":123456789012345678901,"text":"ok"}'
    const parsed = parseWireJson<{ message_id: string; msg_id: string; text: string }>(raw)
    expect(parsed.message_id).toBe("7514975623787282440")
    expect(parsed.msg_id).toBe("123456789012345678901")
    expect(parsed.text).toBe("ok")
  })

  test("client id matches the shape the backend expects", () => {
    expect(newClientId()).toMatch(/^opencode-wechat:\d+-[0-9a-f]{8}$/)
  })

  test("conversation keys are stable and group-aware", () => {
    expect(conversationKey("bot@im.bot", "user@im.wechat")).toBe("bot@im.bot:user@im.wechat")
    expect(conversationKey("bot@im.bot", "user@im.wechat", "g1")).toBe("bot@im.bot:g1:user@im.wechat")
  })

  test("a refusal is a refusal, not a delivery", () => {
    expect(() => assertSendAccepted({ ret: 0, message_id: "1" })).not.toThrow()
    expect(() => assertSendAccepted({ message_id: "1" })).not.toThrow()
    let error: unknown
    try {
      assertSendAccepted({ ret: -2, errmsg: "prepare failed" })
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(SendRefusedError)
    expect((error as SendRefusedError).errcode).toBe(-2)
    expect((error as SendRefusedError).message).toContain("prepare failed")
  })
})

/*
 * ---------------------------------------------------------------------------
 * Poller lock
 * ---------------------------------------------------------------------------
 */

/*
 * ---------------------------------------------------------------------------
 * Hardening (audit follow-up)
 * ---------------------------------------------------------------------------
 */

describe("chunking edge cases", () => {
  test("a long line inside a code fence does not loop forever", () => {
    // Regression: the fence-reopen guard used to flush a fence-only buffer and
    // restore the same state, so this input spun until the process was killed.
    const blob = "x".repeat(1000)
    const text = ["```js", blob, "```"].join("\n")
    const chunks = chunkText(text, 120)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.length).toBeLessThan(30)
    // "```\n" is appended when a chunk closes inside a fence.
    expect(chunks.every((chunk) => chunk.length <= 124)).toBe(true)
    expect(chunks[0]!.startsWith("```js")).toBe(true)
  })
})

describe("wire guards", () => {
  test("sendText refuses an empty or oversized message before any request", async () => {
    const account = { accountId: "bot@im.bot", token: "t", baseUrl: "http://127.0.0.1:1" }
    await expect(sendText({ account, to: "user@im.wechat", text: "   " })).rejects.toThrow("空")
    await expect(sendText({ account, to: "user@im.wechat", text: "x".repeat(MAX_TEXT_CHARS + 1) })).rejects.toThrow(
      "上限",
    )
  })

  test("sleep resolves immediately on an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    await sleep(5_000, controller.signal)
    expect(Date.now() - started).toBeLessThan(100)
  })

  test("an approval selector refuses what it cannot parse", () => {
    expect(parseSelector("2")).toEqual({ index: 2, all: false })
    expect(parseSelector("all")).toEqual({ all: true })
    expect(parseSelector("2x").invalid).toBe(true)
    expect(parseSelector("abc").invalid).toBe(true)
    expect(parseSelector("0").invalid).toBe(true)
  })
})

describe("media hardening", () => {
  test("a download larger than the budget is refused, not buffered", async () => {
    const { createServer } = await import("node:http")
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" })
      response.end(Buffer.alloc(2048, 7))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    const ref = { full_url: `http://127.0.0.1:${port}/attachment` }

    expect(MAX_DOWNLOAD_BYTES).toBeGreaterThan(1024 * 1024)
    await expect(fetchMedia({ ref, maxBytes: 1024 })).resolves.toBeUndefined()
    const fits = await fetchMedia({ ref, maxBytes: 4096 })
    expect(fits?.byteLength).toBe(2048)

    const closeable = server as unknown as { closeAllConnections?: () => void }
    closeable.closeAllConnections?.()
    server.close()
  })

  test("the inbox keeps recent attachments and drops old ones", () => {
    ensureStateDir()
    const inbox = join(STATE_DIR, "inbox")
    mkdirSync(inbox, { recursive: true })
    const fresh = join(inbox, "fresh.bin")
    const old = join(inbox, "old.bin")
    writeFileSync(fresh, "new")
    writeFileSync(old, "old")
    const longAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(old, longAgo, longAgo)

    expect(pruneInbox()).toBeGreaterThanOrEqual(1)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(old)).toBe(false)
  })

  test("a corrupt state file is backed up instead of silently erased", () => {
    ensureStateDir()
    writeFileSync(STATE_PATH, "{ not json")
    expect(readState().bindings).toEqual({})
    expect(existsSync(`${STATE_PATH}.corrupt`)).toBe(true)
    rmSync(`${STATE_PATH}.corrupt`, { force: true })
  })
  test("abandoned temp files are cleaned from the state directory", () => {
    ensureStateDir()
    const stale = join(STATE_DIR, "lock.json.999.abc.tmp")
    const fresh = join(STATE_DIR, "lock.json.999.def.tmp")
    writeFileSync(stale, "{}")
    writeFileSync(fresh, "{}")
    const longAgo = (Date.now() - 60 * 60 * 1000) / 1000
    utimesSync(stale, longAgo, longAgo)

    expect(pruneStaleTemps()).toBeGreaterThanOrEqual(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    rmSync(fresh, { force: true })
  })
})

describe("poller lock", () => {
  const writeLock = (info: Record<string, unknown>): void => {
    ensureStateDir()
    writeFileSync(LOCK_PATH, JSON.stringify(info))
  }
  const foreignLock = (extra: Record<string, unknown>): Record<string, unknown> => ({
    instanceId: "foreign-instance",
    pid: process.pid,
    location: "test",
    startedAt: Date.now(),
    heartbeat: Date.now(),
    ...extra,
  })

  test("a live owner that keeps polling keeps the slot", () => {
    writeLock(foreignLock({ polledAt: Date.now() }))
    expect(acquireLock("test")).toBeUndefined()
    rmSync(LOCK_PATH, { force: true })
  })

  test("a just-claimed lock without a poll yet is respected", () => {
    // Between claiming the slot and the first completed long poll there is no
    // polledAt; that window must not look like a wedged owner.
    writeLock(foreignLock({}))
    expect(acquireLock("test")).toBeUndefined()
    rmSync(LOCK_PATH, { force: true })
  })

  test("an owner whose poller stopped is taken over", () => {
    // The incident this guards against: the heartbeat keeps the instance
    // looking alive while no long poll ever completes, so the channel goes
    // deaf while every other instance stands by forever.
    writeLock(foreignLock({ polledAt: Date.now() - 5 * 60_000 }))
    const handle = acquireLock("test")
    expect(handle).toBeDefined()
    expect(handle?.info.location).toBe("test")
    handle?.release()
  })

  test("a stale heartbeat is taken over", () => {
    writeLock(foreignLock({ heartbeat: Date.now() - 10 * 60_000, polledAt: Date.now() }))
    const handle = acquireLock("test")
    expect(handle).toBeDefined()
    handle?.release()
  })
})

/*
 * ---------------------------------------------------------------------------
 * Network watchdog
 * ---------------------------------------------------------------------------
 */

describe("network watchdog", () => {
  test("a maintenance tick only counts as a resume after a long gap", () => {
    const now = Date.now()
    expect(isResumeGap(0, now)).toBe(false)
    expect(isResumeGap(now - 10_000, now)).toBe(false)
    expect(isResumeGap(now - 5 * 60_000, now)).toBe(true)
  })

  test("polls that never get an answer are reported, and recovery is noticed", async () => {
    // A server that accepts the request and then says nothing: exactly what a
    // portal that logged out, or a stale NAT entry, leaves behind.
    const { createServer } = await import("node:http")
    let mode: "hang" | "answer" = "hang"
    const server = createServer((_request, response) => {
      if (mode === "hang") return
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ret: 0, msgs: [] }))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const timeouts: number[] = []
    let recovered = 0
    const monitor = new ChannelMonitor({
      account: { accountId: "bot@im.bot", token: "token", baseUrl: `http://127.0.0.1:${port}` },
      onMessage: async () => {},
      initialTimeoutMs: 30,
      timeoutGraceMs: 20,
      onTimeout: (consecutive) => {
        timeouts.push(consecutive)
      },
      onRecovered: () => {
        recovered += 1
      },
    })

    const controller = new AbortController()
    const running = monitor.run(controller.signal)

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(timeouts.length).toBeGreaterThanOrEqual(2)
    expect(timeouts[0]).toBe(1)
    expect(monitor.consecutiveTimeouts).toBeGreaterThanOrEqual(2)

    mode = "answer"
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()
    await running

    expect(recovered).toBeGreaterThanOrEqual(1)
    expect(monitor.consecutiveTimeouts).toBe(0)
    const closeable = server as unknown as { closeAllConnections?: () => void }
    closeable.closeAllConnections?.()
    server.close()
  })
})
