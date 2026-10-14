/**
 * Bridge behaviour, exercised end to end against mocks.
 *
 * The WeChat backend cannot be reached from a test, so the two things the bridge
 * talks to are mocked: the iLink service (send/typing/notify endpoints) and the
 * local OpenCode HTTP API (sessions, forms, permissions). The plugin context is
 * a small fake, which is what makes the *commands* testable — `/switch`,
 * `/rename`, `/model`, `/cancel` and friends used to be paths nobody had ever
 * run.
 *
 * Only behaviour that can be observed from outside is asserted: what was sent
 * to WeChat, what was asked of OpenCode, and what the state file says.
 *
 *   bun test
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Bridge } from "../bridge.ts"
import { LocalApi } from "../api.ts"
import { DEFAULT_CONFIG, type WechatConfig } from "../config.ts"
import { STATE_PATH, readState } from "../state.ts"

/* ------------------------------------------------------------------ iLink -- */

interface SentRequest {
  path: string
  body: Record<string, unknown>
}

interface ILinkMock {
  url: string
  /** Every sendmessage request, accepted or refused. */
  attempts: SentRequest[]
  /** Texts the service accepted, in order. */
  delivered: string[]
  /** While true, sendmessage answers the way a closed reply window does. */
  refuseSends: boolean
  /** While true, only sends carrying a `context_token` are refused. */
  refuseContextTokens: boolean
  server: Server
}

async function startILink(): Promise<ILinkMock> {
  const mock: ILinkMock = {
    url: "",
    attempts: [],
    delivered: [],
    refuseSends: false,
    refuseContextTokens: false,
    server: undefined as unknown as Server,
  }

  const read = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(chunk as Buffer))
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })

  mock.server = createServer((request, response) => {
    void (async () => {
      const raw = request.method === "POST" ? await read(request) : ""
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      const path = `${request.method} ${(request.url ?? "/").split("?")[0]}`

      const json = (payload: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify(payload))
      }

      if (path === "POST /ilink/bot/sendmessage") {
        mock.attempts.push({ path, body })
        const msg = body.msg as
          | { context_token?: string; item_list?: Array<{ text_item?: { text?: string } }> }
          | undefined
        if (mock.refuseSends || (mock.refuseContextTokens && msg?.context_token)) {
          json({ ret: -2, errmsg: "prepare failed" })
          return
        }
        mock.delivered.push(msg?.item_list?.[0]?.text_item?.text ?? "")
        json({ ret: 0, message_id: "7514975623787282440" })
        return
      }
      if (path === "POST /ilink/bot/getconfig") {
        json({ ret: 0, typing_ticket: "ticket-1" })
        return
      }
      json({ ret: 0 })
    })()
  })

  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", () => {
      const address = mock.server.address()
      const port = typeof address === "object" && address ? address.port : 0
      mock.url = `http://127.0.0.1:${port}`
      resolve()
    })
  })

  return mock
}

/* ----------------------------------------------------------- OpenCode API -- */

interface ApiMock {
  url: string
  file: string
  sessions: Array<Record<string, unknown>>
  /** Sessions the plugin created through the fake context, read live. */
  created: () => Array<Record<string, unknown>>
  /** Session ids reported as running. */
  active: string[]
  forms: Array<Record<string, unknown>>
  permissions: Array<Record<string, unknown>>
  answered: Array<{ formID: string; answer: Record<string, unknown> }>
  /** Answer 500 instead of 204, to test the failure path. */
  breakReply: boolean
  server: Server
}

async function startApi(): Promise<ApiMock> {
  const mock: ApiMock = {
    url: "",
    file: "",
    sessions: [],
    created: () => [],
    active: [],
    forms: [],
    permissions: [],
    answered: [],
    breakReply: false,
    server: undefined as unknown as Server,
  }
  const allSessions = (): Array<Record<string, unknown>> => [...mock.sessions, ...mock.created()]

  const read = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(chunk as Buffer))
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })

  mock.server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      const raw = request.method === "POST" || request.method === "PATCH" ? await read(request) : ""
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}

      const json = (payload: unknown, status = 200): void => {
        response.writeHead(status, { "content-type": "application/json" })
        response.end(JSON.stringify(payload))
      }

      if (url.pathname === "/api/info") {
        json({ version: "2.0.26", pid: process.pid })
        return
      }
      if (url.pathname === "/api/session") {
        json({ data: allSessions() })
        return
      }
      if (url.pathname === "/api/session/active") {
        json({ data: Object.fromEntries(mock.active.map((id) => [id, { type: "running" }])) })
        return
      }
      // A single session, as `/current` and `/cost` read it.
      const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/)
      if (sessionMatch && request.method === "GET") {
        const found = allSessions().find((session) => session.id === sessionMatch[1])
        if (!found) {
          json({ _tag: "SessionNotFoundError", sessionID: sessionMatch[1], message: "gone" }, 404)
          return
        }
        json({ data: found })
        return
      }
      if (url.pathname.endsWith("/form") && request.method === "GET") {
        const sessionID = url.pathname.split("/")[3]
        json({ data: mock.forms.filter((form) => form.sessionID === sessionID) })
        return
      }
      // One form's state: the bridge asks after a rejected submit to tell
      // "still waiting" apart from "gone".
      const formMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)$/)
      if (formMatch && request.method === "GET") {
        const found = mock.forms.find((form) => form.id === formMatch[2])
        if (!found) {
          json({ _tag: "FormNotFoundError", id: formMatch[2], message: "gone" }, 404)
          return
        }
        json({ data: found })
        return
      }
      if (url.pathname.includes("/form/") && url.pathname.endsWith("/reply")) {
        if (mock.breakReply) {
          json({ _tag: "UnknownError", message: "boom" }, 500)
          return
        }
        const formID = url.pathname.split("/form/")[1].replace("/reply", "")
        mock.answered.push({ formID, answer: (body.answer ?? {}) as Record<string, unknown> })
        const target = mock.forms.find((form) => form.id === formID)
        if (target) target.state = { status: "answered", answer: body.answer }
        response.writeHead(204)
        response.end()
        return
      }
      if (url.pathname === "/api/permission/request") {
        json({ data: mock.permissions })
        return
      }
      json({ data: [] }, 404)
    })()
  })

  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", () => {
      const address = mock.server.address()
      const port = typeof address === "object" && address ? address.port : 0
      mock.url = `http://127.0.0.1:${port}`
      resolve()
    })
  })

  return mock
}

/* --------------------------------------------------------------- fake ctx -- */

interface Calls {
  prompts: Array<Record<string, unknown>>
  creates: Array<Record<string, unknown>>
  updates: Array<Record<string, unknown>>
  switched: Array<Record<string, unknown>>
  interrupts: Array<Record<string, unknown>>
  permissionReplies: Array<Record<string, unknown>>
}

function makeContext(calls: Calls, sessions = new Map<string, Record<string, unknown>>()) {
  let counter = 0
  const models = { location: { directory: "/tmp" }, data: [
    { id: "fast", providerID: "acme", name: "Fast", enabled: true, cost: [{ input: 0.1 }], limit: { context: 200_000 } },
    { id: "smart", providerID: "acme", name: "Smart", enabled: true },
  ] }

  return {
    app: { name: "opencode", version: "2.0.26", channel: "test" },
    location: { directory: "/tmp", project: { id: "proj" } },
    options: {},
    session: {
      create: async (input: Record<string, unknown>) => {
        calls.creates.push(input)
        const id = `ses_test${(counter += 1)}`
        sessions.set(id, { id, title: input.title, location: input.location, agent: input.agent, model: input.model })
        return { id }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (!session) throw new Error(`SessionNotFoundError: ${sessionID}`)
        return session
      },
      update: async (input: Record<string, unknown>) => {
        calls.updates.push(input)
        const session = sessions.get(String(input.sessionID))
        if (session) session.title = input.title
      },
      prompt: async (input: Record<string, unknown>) => {
        calls.prompts.push(input)
        return { id: "msg_test" }
      },
      switchModel: async (input: Record<string, unknown>) => {
        calls.switched.push({ kind: "model", ...input })
      },
      switchAgent: async (input: Record<string, unknown>) => {
        calls.switched.push({ kind: "agent", ...input })
      },
      interrupt: async (input: Record<string, unknown>) => {
        calls.interrupts.push(input)
      },
      synthetic: async () => ({ id: "msg_synthetic" }),
      remove: async () => {},
    },
    model: {
      list: async () => models,
      default: async () => ({ location: { directory: "/tmp" }, data: { modelID: "fast", providerID: "acme" } }),
    },
    agent: {
      list: async () => ({
        location: { directory: "/tmp" },
        data: [
          { id: "build", name: "Build", mode: "primary" },
          { id: "plan", name: "Plan", mode: "primary" },
          { id: "helper", name: "Helper", mode: "subagent", hidden: true },
        ],
      }),
    },
    permission: {
      reply: async (input: Record<string, unknown>) => {
        calls.permissionReplies.push(input)
      },
    },
    event: {
      subscribe: () => ({ [Symbol.asyncIterator]: async function* () {} }),
    },
    tool: { transform: async () => ({ dispose: async () => {} }), list: async () => [], reload: async () => {} },
    plugin: { list: async () => [] },
  }
}

/* ---------------------------------------------------------------- harness -- */

const ilink = await startILink()
const apiMock = await startApi()

/**
 * Paths this suite writes to.
 *
 * The service file is always our own: with a user-set `WECHAT_SERVICE_FILE` the
 * preload would respect it and the harness would overwrite a real registration.
 */
const TEST_SERVICE_FILE = join(mkdtempSync(join(tmpdir(), "wechat-service-")), "service.json")
process.env.WECHAT_SERVICE_FILE = TEST_SERVICE_FILE
/** The shared state directory the preload set up. */
const TEST_STATE_DIR = process.env.WECHAT_STATE_DIR ?? mkdtempSync(join(tmpdir(), "wechat-state-"))

// A registration file for the plugin client to read (tests must never reach the
// real service).
writeFileSync(TEST_SERVICE_FILE, JSON.stringify({ url: apiMock.url, pid: process.pid, password: "test-password" }))

const CONVERSATION = "bot@im.bot:user@im.wechat"

interface Harness {
  bridge: Bridge
  calls: Calls
  logs: string[]
  config: WechatConfig
  sessions: Map<string, Record<string, unknown>>
}

async function harness(overrides: Partial<WechatConfig> = {}, options: { keepState?: boolean } = {}): Promise<Harness> {
  const calls: Calls = { prompts: [], creates: [], updates: [], switched: [], interrupts: [], permissionReplies: [] }
  const logs: string[] = []
  const sessions = new Map<string, Record<string, unknown>>()
  // The fake context must know the sessions the mock API lists, because
  // lending a desktop session to the phone reads it through `session.get`.
  for (const session of apiMock.sessions) sessions.set(String(session.id), session)
  // …and the API must know the sessions the plugin creates, because the phone's
  // list is built from what the service reports.
  apiMock.created = () => [...sessions.values()]
  // Approval bursts are batched on a timer; tests do not want to wait 800ms.
  const config: WechatConfig = { ...DEFAULT_CONFIG, directory: "/tmp", sendDelayMs: 0, approvalBurstMs: 10, ...overrides }

  // `keepState` simulates a plugin reload: the new instance must pick up the
  // queue the previous one persisted.
  if (!options.keepState) {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        version: 1,
        account: { accountId: "bot@im.bot", token: "token-1", baseUrl: ilink.url, userId: "user@im.wechat" },
        contextTokens: { [CONVERSATION]: "ctx-1" },
        bindings: {},
      }),
    )
  }

  const bridge = new Bridge(
    makeContext(calls, sessions) as never,
    config,
    { info: (message) => logs.push(`info ${message}`), warn: (message) => logs.push(`warn ${message}`) },
    "/tmp",
    new LocalApi({ file: TEST_SERVICE_FILE, cacheMs: 0, timeoutMs: 2_000 }),
  )
  bridge.reloadState()

  return { bridge, calls, logs, config, sessions }
}

function inbound(text: string, options: { id?: string } = {}) {
  return {
    accountId: "bot@im.bot",
    peerId: "user@im.wechat",
    conversationId: CONVERSATION,
    messageId: options.id ?? `msg-${Math.random().toString(16).slice(2)}`,
    contextToken: "ctx-1",
    text,
    receivedAt: Date.now(),
  }
}

/** Texts the service accepted, newest last. */
function sentTexts(): string[] {
  return [...ilink.delivered]
}

/** Forget everything sent so far, so the next assertion sees only new traffic. */
function clearSent(): void {
  ilink.attempts.length = 0
  ilink.delivered.length = 0
}

/**
 * Wait until a condition holds (or fail after a deadline).
 *
 * Fixed sleeps flip on a loaded CI box: the assertion runs before the timer it
 * depends on. Waiting on the observable outcome instead is both faster and
 * stable.
 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const DEFAULT_SESSIONS = [
  { id: "ses_remote1", title: "桌面端的会话", location: { directory: "D:\\code\\app" }, time: { updated: Date.now() } },
  { id: "ses_remote2", title: "另一个会话", location: { directory: "D:\\code\\docs" }, time: { updated: Date.now() } },
]

beforeAll(() => {
  apiMock.sessions = [...DEFAULT_SESSIONS]
})

beforeEach(() => {
  clearSent()
  ilink.refuseSends = false
  // Copies, not the shared literals: lending a session renames its title
  // (the 📱 marker), and the next test must not inherit that mutation.
  apiMock.sessions = DEFAULT_SESSIONS.map((session) => ({ ...session }))
  apiMock.active = []
  apiMock.forms = []
  apiMock.permissions = []
  apiMock.answered = []
  apiMock.breakReply = false
})

afterAll(() => {
  ilink.server.close()
  apiMock.server.close()
  rmSync(TEST_SERVICE_FILE, { force: true })
})

/* ------------------------------------------------------------------ tests -- */

describe("inbound messages", () => {
  test("creates a session, prompts it, and remembers the conversation", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("帮我看看这个仓库"))

    expect(calls.creates.length).toBe(1)
    expect(calls.prompts.length).toBe(1)
    expect(calls.prompts[0].text).toBe("帮我看看这个仓库")
    expect(calls.prompts[0].sessionID).toBe("ses_test1")

    const state = readState()
    expect(state.bindings[CONVERSATION]?.sessionID).toBe("ses_test1")
    expect(state.lastConversation).toBe(CONVERSATION)
    expect(state.seenMessages?.length).toBe(1)
  })

  test("the first message creates the phone's home channel", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("帮我看看这个仓库"))

    // The first message does not invent a session per topic: it establishes the
    // channel the phone lives in, which stays pinned on top of its list.
    expect(calls.creates.length).toBe(1)
    expect(calls.creates[0].title).toBe("主会话")
    expect(calls.creates[0].metadata).toEqual({ wechat: { origin: "phone" } })
    expect(readState().channelSessionID).toBe("ses_test1")
    expect(calls.prompts[0].text).toBe("帮我看看这个仓库")

    // A second message reuses it rather than creating another session.
    await bridge.handleInbound(inbound("第二条"))
    expect(calls.creates.length).toBe(1)
    expect(calls.prompts[1].sessionID).toBe("ses_test1")
  })

  test("/new names its session after the instruction", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("你好"))
    await bridge.handleInbound(inbound("/new 修复登录流程：把 token 过期当成重新登录"))
    expect(calls.creates.length).toBe(2)
    expect(calls.creates[1].title).toBe("修复登录流程：把 token 过期当成重新登录")
    // …and the conversation moved there, leaving the channel behind.
    expect(readState().bindings[CONVERSATION]?.sessionID).not.toBe(readState().channelSessionID)
  })

  test("creates the session with agent and model pinned", async () => {
    const { bridge, calls } = await harness({ agent: "plan" })
    await bridge.handleInbound(inbound("你好"))
    expect(calls.creates[0].agent).toBe("plan")
    expect(calls.creates[0].model).toEqual({ providerID: "acme", id: "fast" })
  })

  test("ignores a duplicate delivery", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("只处理一次", { id: "dupe-1" }))
    await bridge.handleInbound(inbound("只处理一次", { id: "dupe-1" }))
    expect(calls.prompts.length).toBe(1)
  })

  test("ignores a sender outside the allowlist", async () => {
    const { bridge, calls } = await harness({ allowedUsers: ["someone-else@im.wechat"] })
    await bridge.handleInbound(inbound("你好"))
    expect(calls.prompts.length).toBe(0)
    expect(calls.creates.length).toBe(0)
  })

  test("reuses a bound session instead of creating a new one", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("第一条"))
    await bridge.handleInbound(inbound("第二条"))
    expect(calls.creates.length).toBe(1)
    expect(calls.prompts.length).toBe(2)
    expect(calls.prompts[1].sessionID).toBe(calls.prompts[0].sessionID)
  })

  test("replaces a binding whose session no longer exists", async () => {
    const { bridge, calls, sessions } = await harness()
    await bridge.handleInbound(inbound("第一条"))
    const first = String(calls.prompts[0].sessionID)
    sessions.delete(first)

    await bridge.handleInbound(inbound("第二条"))
    expect(calls.creates.length).toBe(2)
    expect(calls.prompts[1].sessionID).not.toBe(first)
  })

  test("an image with no caption is titled by its kind, not by the notice", async () => {
    const { bridge, calls } = await harness()
    // Give the phone a session first, so the image lands in a fresh one.
    await bridge.handleInbound(inbound("你好"))
    clearSent()
    await bridge.handleInbound(inbound("/new"))
    await bridge.handleInbound({
      ...inbound(""),
      media: [{ type: 2, msg_id: "1", image_item: { media: { full_url: "http://127.0.0.1:1/nope" } } }],
    })
    // The download fails (nothing listens there), which is fine: the point is
    // that the session is not named after the bridge's own note.
    expect(String(calls.prompts.at(-1)?.text)).toContain("[")
  })

  test("attachments are handed to the model as local files", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound({ ...inbound(""), media: [] })
    clearSent()
    // A file item the mock download endpoint cannot serve still yields a prompt.
    await bridge.handleInbound({
      ...inbound("看下这个"),
      media: [{ type: 4, msg_id: "2", file_item: { file_name: "report.pdf", media: { full_url: "http://127.0.0.1:1/nope" } } }],
    })
    expect(String(calls.prompts.at(-1)?.text)).toContain("看下这个")
    expect(String(calls.prompts.at(-1)?.text)).toContain("report.pdf")
  })
})

describe("commands", () => {
  test("/help explains itself without prompting the agent", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/help"))
    expect(calls.prompts.length).toBe(0)
    expect(sentTexts()[0]).toContain("opencode 微信通道")
  })

  test("/help <command> explains one command, /help 全部 the whole manual", async () => {
    const { bridge } = await harness()

    await bridge.handleInbound(inbound("/help attach"))
    const card = sentTexts().join("\n")
    expect(card).toContain("用法：/attach 序号|id")
    expect(card).toContain("/follow")

    clearSent()
    await bridge.handleInbound(inbound("/help 全部"))
    const manual = sentTexts().join("\n")
    expect(manual).toContain("逐条详解")
    expect(manual).toContain("/channel")

    clearSent()
    await bridge.handleInbound(inbound("/help 没有这条"))
    expect(sentTexts().join("\n")).toContain("没有这条命令")
  })

  test("/new creates and binds a session, and accepts a directory", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 通道自测"))
    expect(calls.creates[0].title).toBe("通道自测")
    expect(sentTexts()[0]).toContain("新会话已就绪")

    clearSent()
    await bridge.handleInbound(inbound(`/new ${TEST_STATE_DIR}`))
    expect(calls.creates[1].location).toEqual({ directory: TEST_STATE_DIR })
    expect(sentTexts()[0]).toContain("新会话已就绪")
  })

  test("/list shows the phone's own sessions with the channel pinned", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/list"))
    const text = sentTexts().join("\n")
    expect(text).toContain("手机会话")
    expect(text).toContain("📌")
    expect(text).toContain("主会话")
    // Terminal sessions are not mixed into the phone's list.
    expect(text).not.toContain("桌面端的会话")
  })

  test("/list all holds everything else, and its indices attach", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    clearSent()
    await bridge.handleInbound(inbound("/list all"))
    const listing = sentTexts().join("\n")
    expect(listing).toContain("其他会话")
    expect(listing).toContain("桌面端的会话")

    clearSent()
    await bridge.handleInbound(inbound("/attach 1"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")
    expect(sentTexts().join("\n")).toContain("接到微信")
  })

  test("/list pages with global indices, so a number keeps its meaning", async () => {
    const { bridge } = await harness({ listLimit: 1 })
    await bridge.handleInbound(inbound("你好"))
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    // Two phone sessions with a page size of one: the hint points at page two.
    await bridge.handleInbound(inbound("/list"))
    const page1 = sentTexts().join("\n")
    expect(page1).toContain("第 1/2 页")
    expect(page1).toContain("翻页：/list 2")

    clearSent()
    await bridge.handleInbound(inbound("/list 2"))
    const page2 = sentTexts().join("\n")
    expect(page2).toContain("第 2/2 页")
    // The row keeps its global number (2), so `/attach 2` means the same thing
    // no matter which page the user read the number from.
    expect(page2).toContain("2. 我的会话")

    // The "everything else" list pages the same way. Only the mock's desktop
    // sessions count here: the phone's own two are filtered out, and the API
    // reports them before the ones the harness created.
    apiMock.sessions = [
      { id: "ses_remote3", title: "第三个", location: { directory: "D:\\code\\third" }, time: { updated: Date.now() } },
      { id: "ses_remote4", title: "第四个", location: { directory: "D:\\code\\fourth" }, time: { updated: Date.now() } },
    ]
    clearSent()
    await bridge.handleInbound(inbound("/list all"))
    expect(sentTexts().join("\n")).toContain("第 1/2 页")

    clearSent()
    await bridge.handleInbound(inbound("/list all 2"))
    const others2 = sentTexts().join("\n")
    expect(others2).toContain("第 2/2 页")
    // Global numbering: row three is the first desktop session, and that number
    // is what a later `/attach 3` resolves against.
    expect(others2).toContain("3. 桌面端的会话")

    clearSent()
    await bridge.handleInbound(inbound("/attach 3"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")
  })

  test("the phone list always keeps the channel, even when it is the only entry", async () => {
    const { bridge } = await harness({ listLimit: 1 })
    await bridge.handleInbound(inbound("你好"))
    clearSent()
    await bridge.handleInbound(inbound("/list"))
    const text = sentTexts().join("\n")
    expect(text).toContain("主会话")
    expect(text).toContain("📌")
  })

  test("/switch rebinds by index and by id", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleInbound(inbound("/switch 1"))
    expect(sentTexts()[0]).toContain("已切换")
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")

    clearSent()
    await bridge.handleInbound(inbound("/switch ses_remote2"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote2")

    clearSent()
    await bridge.handleInbound(inbound("/switch 99"))
    expect(sentTexts()[0]).toContain("没找到")
  })

  test("/current describes the bound session", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/current"))
    const text = sentTexts().join("\n")
    expect(text).toContain("当前会话")
    expect(text).toContain("ses_test1")
  })

  test("/rename renames the session", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 旧名字"))
    clearSent()
    await bridge.handleInbound(inbound("/rename 新名字"))
    expect(calls.updates.at(-1)?.title).toBe("新名字")
    expect(readState().bindings[CONVERSATION]?.title).toBe("新名字")
    expect(sentTexts()[0]).toContain("已重命名")
  })

  test("/cancel interrupts, and /cancel all drops the queue", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/cancel"))
    expect(calls.interrupts.length).toBe(1)
    expect(sentTexts()[0]).toContain("已请求中断")
  })

  test("/model lists models and switches by index", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleInbound(inbound("/model"))
    const listing = sentTexts().join("\n")
    expect(listing).toContain("acme/fast")
    expect(listing).toContain("acme/smart")

    clearSent()
    await bridge.handleInbound(inbound("/model 2"))
    expect(calls.switched.at(-1)).toMatchObject({ kind: "model", model: { providerID: "acme", id: "smart" } })
    expect(sentTexts()[0]).toContain("已切换模型")
  })

  test("/agent lists primary agents and switches", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleInbound(inbound("/agent"))
    const listing = sentTexts().join("\n")
    expect(listing).toContain("Build")
    expect(listing).not.toContain("Helper") // subagents are hidden

    clearSent()
    await bridge.handleInbound(inbound("/agent 2"))
    expect(calls.switched.at(-1)).toMatchObject({ kind: "agent", agent: "plan" })
  })

  test("/cost reports the session usage", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.sessions = [
      { id: "ses_test1", title: "我的会话", cost: 1.2345, location: { directory: "/tmp" }, time: { updated: Date.now() } },
    ]
    clearSent()
    await bridge.handleInbound(inbound("/cost"))
    const text = sentTexts().join("\n")
    expect(text).toContain("当前会话用量")
    expect(text).toContain("1.2345")
  })

  test("/dir validates and stores the default directory", async () => {
    const { bridge } = await harness()
    clearSent()
    await bridge.handleInbound(inbound("/dir /definitely/not/a/directory"))
    expect(sentTexts()[0]).toContain("目录不存在")

    clearSent()
    await bridge.handleInbound(inbound(`/dir ${TEST_STATE_DIR}`))
    expect(sentTexts()[0]).toContain("默认目录已设为")
    expect(readState().defaultDirectory).toBe(TEST_STATE_DIR)
  })

  test("/status, /whoami, /ping and /log answer without the agent", async () => {
    const { bridge, calls } = await harness()
    for (const command of ["/status", "/whoami", "/ping", "/log 5"]) {
      clearSent()
      await bridge.handleInbound(inbound(command))
      expect(sentTexts().join("\n").length).toBeGreaterThan(0)
    }
    expect(calls.prompts.length).toBe(0)
  })

  test("an unknown slash command falls through to the agent", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/usr/bin/env 是什么"))
    // It is a message, not a command: the agent sees it and a session exists.
    expect(calls.prompts.length).toBe(1)
  })

  test("/last swaps back to the previous session", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const mine = readState().bindings[CONVERSATION]?.sessionID

    await bridge.handleInbound(inbound("/switch 1"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")

    clearSent()
    await bridge.handleInbound(inbound("/last"))
    const state = readState()
    expect(state.bindings[CONVERSATION]?.sessionID).toBe(mine)
    expect(state.bindings[CONVERSATION]?.previousSessionID).toBe("ses_remote1")
    expect(sentTexts()[0]).toContain("已切回")
  })

  test("/last without a history says so", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/last"))
    expect(sentTexts()[0]).toContain("还没有切换记录")
  })

  test("/queue reports nothing stuck, and /queue clear is harmless", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/queue"))
    expect(sentTexts()[0]).toContain("没有待发消息")

    clearSent()
    await bridge.handleInbound(inbound("/queue clear"))
    expect(sentTexts()[0]).toContain("没有待发消息")
  })

  test("a stuck reply is delivered before the answer to the next message", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    // The window is closed: the turn's text is queued instead of lost.
    ilink.refuseSends = true
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "发不出去的内容" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    expect(sentTexts().length).toBe(0)

    // The user writes again, which reopens it. The stuck reply arrives first,
    // then the reply to the new message — and nothing is left queued.
    ilink.refuseSends = false
    clearSent()
    await bridge.handleInbound(inbound("/queue"))
    const texts = sentTexts()
    // The notice explains the gap, then the stuck answer itself arrives.
    expect(texts[0]).toContain("没发完")
    expect(texts[1]).toBe("发不出去的内容")
    expect(texts[2]).toContain("没有待发消息")

    clearSent()
    ilink.refuseSends = true
    await bridge.handleInbound(inbound("再试一次"))
    expect(sentTexts().length).toBe(0)
    ilink.refuseSends = false
  })

  test("/more delivers stuck text without bothering the model", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const promptsBefore = calls.prompts.length

    // The window is shut: the answer is queued, with a notice in front of it.
    ilink.refuseSends = true
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "被卡住的回答" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    ilink.refuseSends = false
    clearSent()

    await bridge.handleInbound(inbound("/more"))
    const texts = sentTexts()
    expect(texts.some((text) => text.includes("没发完"))).toBe(true)
    expect(texts).toContain("被卡住的回答")
    // The inbound itself flushed the queue, so /more explains that instead of
    // asking the model to rewrite what just arrived.
    expect(texts.at(-1)).toContain("已经补发")
    // Nothing was asked of the model: the text was simply stuck.
    expect(calls.prompts.length).toBe(promptsBefore)
  })

  test("/more asks the model to continue instead of forwarding the word", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleInbound(inbound("/more"))
    expect(calls.prompts.length).toBe(1)
    const prompt = String(calls.prompts[0]!.text)
    expect(prompt).toContain("续写")
    expect(prompt).not.toBe("继续")
    // The request is for the model, not a message to the phone.
    expect(sentTexts().length).toBe(0)
  })

  test("/more reports text that is still stuck instead of pretending", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const promptsBefore = calls.prompts.length

    // Window shut for both the answer and the /more that follows it.
    ilink.refuseSends = true
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "还卡着呢" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    clearSent()

    await bridge.handleInbound(inbound("/more"))
    // Even the explanation cannot go out while the window is shut; it joins the
    // queue, and the model is not bothered.
    const queued = readState().pendingOutbound?.[CONVERSATION] ?? []
    expect(queued.some((item) => item.includes("还有"))).toBe(true)
    expect(calls.prompts.length).toBe(promptsBefore)

    // Once the user speaks again everything lands, explanation first.
    ilink.refuseSends = false
    clearSent()
    await bridge.handleInbound(inbound("在吗"))
    const delivered = sentTexts().join("\n")
    expect(delivered).toContain("没发完")
    expect(delivered).toContain("还卡着呢")
    expect(delivered).toContain("还有")
  })

  test("a second failure does not stack another notice", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true

    for (const text of ["第一条发不出去", "第二条也发不出去"]) {
      await bridge.handleEvent({
        type: "session.text.ended",
        data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text },
      })
      await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    }

    const queued = readState().pendingOutbound?.[CONVERSATION] ?? []
    expect(queued.filter((item) => item.includes("没发完")).length).toBe(1)
    expect(queued).toContain("第一条发不出去")
    expect(queued).toContain("第二条也发不出去")
    ilink.refuseSends = false
  })

  test("a long answer is numbered so a missing part is obvious", async () => {
    const { bridge } = await harness({ chunkSize: 200 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    const answer = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行内容`).join("\n")
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: answer },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })

    const texts = sentTexts()
    expect(texts.length).toBeGreaterThan(1)
    expect(texts[0]!.startsWith("（1/")).toBe(true)
    expect(texts.at(-1)).toContain(`/${texts.length}）`)
    // The marker must not push a chunk past the limit: the tail would be lost.
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(200)
  })
})

describe("approvals", () => {
  const permission = (id: string, action = "bash", resources = ["rm -rf build"]) => ({
    id,
    sessionID: "ses_test1",
    action,
    resources,
  })

  /**
   * Approvals are announced after a short burst window: wait for the message
   * rather than guessing a duration. `settle(0)` is for the case where nothing
   * may be announced — it gives the window time to (not) fire.
   */
  const settle = async (expected = 1): Promise<void> => {
    if (expected === 0) {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return
    }
    await waitFor(() => sentTexts().length >= expected, 2_000, "approval announcement")
  }

  test("a request is pushed with numbered options", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_1") })
    await settle()

    const text = sentTexts().join("\n")
    expect(text).toContain("需要你确认")
    expect(text).toContain("1 = 允许一次")
    expect(text).toContain("rm -rf build")
  })

  test("a burst of requests becomes one message", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({ type: "permission.asked", data: permission("per_1") })
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_2", "edit", ["src/app.ts"]) })
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_3", "bash", ["npm test"]) })
    await settle()

    const texts = sentTexts()
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain("需要你确认（3 项）")
    expect(texts[0]).toContain("1. 执行命令 — rm -rf build")
    expect(texts[0]).toContain("/allow 序号")
  })

  test('a bare "1" replies once and confirms', async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_1") })
    await settle()
    clearSent()

    await bridge.handleInbound(inbound("1"))
    expect(calls.permissionReplies.at(-1)).toEqual({
      sessionID: "ses_test1",
      requestID: "per_1",
      decision: "once",
    })
    expect(sentTexts()[0]).toContain("允许一次")
    // The user's "1" is consumed by the approval, not sent to the agent.
    expect(calls.prompts.length).toBe(0)
  })

  test("a refusal keyword rejects", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_2") })
    await settle()
    await bridge.handleInbound(inbound("拒绝"))
    expect(calls.permissionReplies.at(-1)?.decision).toBe("reject")
  })

  test("queued approvals can be answered by index or all at once", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_1") })
    await bridge.handleEvent({ type: "permission.asked", data: permission("per_2", "edit", ["src/app.ts"]) })
    await settle()
    clearSent()

    await bridge.handleInbound(inbound("/allow 2"))
    expect(calls.permissionReplies.at(-1)).toMatchObject({ requestID: "per_2", decision: "once" })

    await bridge.handleInbound(inbound("/deny all"))
    expect(calls.permissionReplies.at(-1)).toMatchObject({ requestID: "per_1", decision: "reject" })
  })

  test("an approval for an unrelated session is not relayed", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({ type: "permission.asked", data: { ...permission("per_9"), sessionID: "ses_other" } })
    await settle(0)
    expect(sentTexts().length).toBe(0)
  })
})

describe("agent questions (forms)", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_test1",
    title: "选一个",
    fields: [
      { key: "pm", type: "string", title: "包管理器", required: true, options: [{ value: "pnpm", label: "pnpm" }, { value: "npm", label: "npm" }] },
      { key: "tests", type: "boolean", title: "跑测试", required: true },
    ],
  }

  test("the question is pushed with its options", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({ type: "form.created", data: { form } })

    const text = sentTexts().join("\n")
    expect(text).toContain("想问你")
    expect(text).toContain("pnpm")
    expect(text).toContain("/answer")
  })

  test("/answer submits through the local API and confirms", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "form.created", data: { form } })
    clearSent()

    await bridge.handleInbound(inbound("/answer 1=1；2=否"))
    expect(apiMock.answered.at(-1)).toEqual({ formID: "frm_1", answer: { pm: "pnpm", tests: false } })
    const confirmation = sentTexts().join("\n")
    expect(confirmation).toContain("已提交回答")
    expect(confirmation).toContain("否")
  })

  test("a rejected submit keeps the question and says why", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "form.created", data: { form } })
    // The service still holds the question, it just refused this submission.
    apiMock.forms = [{ ...form, state: { status: "pending" } }]
    apiMock.breakReply = true
    clearSent()

    await bridge.handleInbound(inbound("/answer 1=1；2=是"))
    expect(sentTexts().join("\n")).toContain("提交被拒绝")

    // Still answerable afterwards.
    apiMock.breakReply = false
    clearSent()
    await bridge.handleInbound(inbound("/answer 1=2；2=是"))
    expect(apiMock.answered.at(-1)?.answer).toEqual({ pm: "npm", tests: true })
  })

  test("a request that is genuinely gone is reported as expired, not as our fault", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "form.created", data: { form } })
    apiMock.breakReply = true
    apiMock.forms = [] // the service no longer knows it
    clearSent()

    await bridge.handleInbound(inbound("/answer 1=1；2=是"))
    expect(sentTexts().join("\n")).toContain("已经过期或被取消")
  })

  test("an incomplete answer is refused before reaching the service", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({ type: "form.created", data: { form } })
    clearSent()

    await bridge.handleInbound(inbound("/answer 1=1"))
    expect(apiMock.answered.length).toBe(0)
    expect(sentTexts().join("\n")).toContain("还没回答")
  })

  test("/answer without a question says so", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/answer 1"))
    expect(sentTexts().join("\n")).toContain("没有待回答")
  })
})

describe("replies back to WeChat", () => {
  test("a finished turn is delivered as one message", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "第一段" },
    })
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 1, text: "第二段" },
    })
    // Nothing goes out until the turn ends.
    expect(sentTexts().length).toBe(0)

    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    expect(sentTexts()).toEqual(["第一段\n\n第二段"])
  })

  test("when idle never arrives, the grace timer still delivers", async () => {
    const { bridge } = await harness({ turnGraceMs: 30 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "没有 idle 的答案" },
    })
    // Nothing yet: the grace window exists so the turn's blocks can merge.
    expect(sentTexts().length).toBe(0)

    await waitFor(() => sentTexts().length > 0, 2_000, "grace delivery")
    expect(sentTexts()).toEqual(["没有 idle 的答案"])
  })

  test("idle and the grace timer together deliver the turn exactly once", async () => {
    const { bridge } = await harness({ turnGraceMs: 40 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "只发一次" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    await waitFor(() => sentTexts().length > 0, 2_000, "turn delivery")
    // Give the grace timer time to (not) send a second copy.
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(sentTexts()).toEqual(["只发一次"])
  })

  test("a failed execution reports the error after the partial text", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "做到一半" },
    })
    clearSent()
    await bridge.handleEvent({
      type: "session.execution.failed",
      data: { sessionID: "ses_test1", error: { message: "模型超时", type: "timeout" } },
    })
    const texts = sentTexts()
    expect(texts[0]).toBe("做到一半")
    expect(texts[1]).toContain("执行失败")
    expect(texts[1]).toContain("模型超时")
  })

  test("tool progress is one line per call, and failures are reported", async () => {
    const { bridge } = await harness({ progress: "tools" })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({ type: "session.tool.called", data: { sessionID: "ses_test1", id: "bash", input: { command: "npm test" } } })
    expect(sentTexts()[0]).toContain("npm test")

    await bridge.handleEvent({
      type: "session.tool.failed",
      data: { sessionID: "ses_test1", id: "bash", error: { message: "exit 1" } },
    })
    expect(sentTexts()[1]).toContain("失败")
    expect(sentTexts()[1]).toContain("exit 1")
  })

  test("progress can be turned off", async () => {
    const { bridge } = await harness({ progress: "off" })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({ type: "session.tool.called", data: { sessionID: "ses_test1", id: "bash", input: {} } })
    expect(sentTexts().length).toBe(0)
  })

  test("concurrent sends for one conversation stay in order", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    // The agent pushing a message while a turn finishes: without a per
    // conversation send chain these chunks would interleave.
    await Promise.all([
      bridge.sendToLast("推送一"),
      bridge.sendToLast("推送二"),
      bridge.sendToLast("推送三"),
    ])
    expect(sentTexts()).toEqual(["推送一", "推送二", "推送三"])
  })

  test("live streaming pushes deltas while the turn runs", async () => {
    const { bridge } = await harness({ stream: "live", streamIntervalMs: 40 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({
      type: "session.text.delta",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, delta: "正在" },
    })
    await bridge.handleEvent({
      type: "session.text.delta",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, delta: "思考" },
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(sentTexts()).toEqual(["正在思考"])

    // The final text must not be sent twice: the deltas already carried it.
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "正在思考" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    expect(sentTexts()).toEqual(["正在思考"])
  })

  test("a turn with no deltas still delivers its text in live mode", async () => {
    const { bridge } = await harness({ stream: "live", streamIntervalMs: 40 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "只有最终文本" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    expect(sentTexts()).toEqual(["只有最终文本"])
  })

  test("a long answer is split into several messages", async () => {
    const { bridge } = await harness({ chunkSize: 200 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    const long = Array.from({ length: 40 }, (_, index) => `第 ${index} 行，一些内容让这一行变长一点。`).join("\n")
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: long },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    const texts = sentTexts()
    expect(texts.length).toBeGreaterThan(1)
    // The parts are numbered; strip the markers before comparing the content.
    const stripped = texts.map((text) => text.replace(/^（\d+\/\d+）\n/, "")).join("\n").replace(/\s/g, "")
    expect(stripped).toBe(long.replace(/\s/g, ""))
  })
})

describe("the reply window", () => {
  test("a refused reply is queued and delivered after the next inbound message", async () => {
    const { bridge, logs } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    clearSent()

    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "这条会被拒" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    expect(sentTexts().length).toBe(0)
    expect(logs.some((line) => line.includes("send refused"))).toBe(true)

    // The user writes again: the window reopens and the queue is flushed first.
    ilink.refuseSends = false
    clearSent()
    await bridge.handleInbound(inbound("在吗"))
    const texts = sentTexts()
    expect(texts[0]).toContain("没发完")
    expect(texts[1]).toBe("这条会被拒")
    expect(logs.some((line) => line.includes("queued send delivered"))).toBe(true)
  })

  test("/retry reports an empty queue instead of pretending", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/retry"))
    expect(sentTexts()[0]).toContain("没有待发消息")
  })

  test("progress lines are dropped when the window is closed, not queued", async () => {
    const { bridge } = await harness({ progress: "tools" })
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    clearSent()

    await bridge.handleEvent({ type: "session.tool.called", data: { sessionID: "ses_test1", id: "bash", input: { command: "npm test" } } })
    await bridge.handleEvent({
      type: "session.tool.failed",
      data: { sessionID: "ses_test1", id: "bash", error: { message: "exit 1" } },
    })

    // A stale "🔧" line arriving minutes later is noise, and it would compete
    // for the reply window the finished answer needs.
    expect(readState().pendingOutbound ?? {}).toEqual({})
  })

  test("the queue survives a plugin reload", async () => {
    const first = await harness()
    await first.bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    await first.bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "重载也不能弄丢我" },
    })
    await first.bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })

    const queued = readState().pendingOutbound?.[CONVERSATION] ?? []
    expect(queued[0]).toContain("没发完")
    expect(queued).toContain("重载也不能弄丢我")

    // A reload: a new instance over the same state file must still have it.
    ilink.refuseSends = false
    clearSent()
    const second = await harness({}, { keepState: true })
    expect(second.bridge.state.pendingOutbound?.[CONVERSATION]).toContain("重载也不能弄丢我")

    await second.bridge.handleInbound(inbound("/retry"))
    expect(sentTexts()).toContain("重载也不能弄丢我")
    expect(readState().pendingOutbound ?? {}).toEqual({})
  })

  test("retries stop after the backoff runs out, and resume on the next message", async () => {
    const { bridge, logs } = await harness({ retryBackoffMs: [5, 5] })
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    clearSent()

    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "等窗口重开" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })

    // Two short retries, then parked: hammering a closed window forever is what
    // produced a storm of stale messages before this existed.
    await waitFor(() => logs.some((line) => line.includes("parked")), 2_000, "parked log")
    const attemptsAfterParking = readState().pendingOutboundAttempts?.[CONVERSATION]
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(readState().pendingOutboundAttempts?.[CONVERSATION]).toBe(attemptsAfterParking)

    // The next inbound message reopens the window and resets the counter.
    ilink.refuseSends = false
    clearSent()
    await bridge.handleInbound(inbound("还在吗"))
    expect(sentTexts()).toContain("等窗口重开")
    expect(readState().pendingOutbound ?? {}).toEqual({})
  })

  test("live mode sends the whole turn when a streamed fragment was dropped", async () => {
    const { bridge } = await harness({ stream: "live", streamIntervalMs: 30 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    clearSent()

    await bridge.handleEvent({
      type: "session.text.delta",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, delta: "前半段" },
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(sentTexts().length).toBe(0) // the fragment was refused

    ilink.refuseSends = false
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "前半段后半段" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
    // The tail alone would have been "后半段" and meaningless on its own.
    expect(sentTexts()).toEqual(["前半段后半段"])
  })
})

describe("wechat_ask", () => {
  test("the question is sent and the answer becomes the result", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    const pending = bridge.ask(CONVERSATION, "要发布吗？", 5_000)
    await waitFor(() => sentTexts().some((text) => text.includes("要发布吗？")), 2_000, "question delivery")

    await bridge.handleInbound(inbound("先别发布"))
    expect(await pending).toBe("先别发布")

    // The answer is consumed by the question, not turned into a new prompt.
    expect(bridge.state.bindings[CONVERSATION]).toBeDefined()
  })

  test("a second question is refused while one is pending", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const pending = bridge.ask(CONVERSATION, "第一个问题", 5_000)
    await waitFor(() => readState().pendingQuestions?.[CONVERSATION] !== undefined, 2_000, "question registered")
    expect(await bridge.ask(CONVERSATION, "第二个问题", 5_000)).toContain("已经有一个问题")
    await bridge.handleInbound(inbound("答案"))
    await pending
  })

  test("it gives up after the timeout", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const answer = await bridge.ask(CONVERSATION, "有人吗", 60)
    expect(answer).toContain("没有回答")
  })
})

describe("reconciliation after a restart", () => {
  test("a pending question and approval are re-registered and re-announced", async () => {
    const { bridge, logs } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.forms = [
      {
        id: "frm_9",
        sessionID: "ses_test1",
        title: "还等你回答",
        fields: [{ key: "a", type: "string", title: "随便", required: true }],
        state: { status: "pending" },
      },
    ]
    apiMock.permissions = [{ id: "per_9", sessionID: "ses_test1", action: "bash", resources: ["ls"] }]
    clearSent()

    await bridge.reconcilePending()
    const text = sentTexts().join("\n")
    expect(text).toContain("还在等你回答")
    expect(text).toContain("还在等你回复")
    expect(logs.some((line) => line.includes("re-registered pending form"))).toBe(true)

    // Answering works right away, without the original event.
    clearSent()
    await bridge.handleInbound(inbound("/answer 随便填"))
    expect(apiMock.answered.at(-1)?.answer).toEqual({ a: "随便填" })
  })

  test("answered questions are not resurrected", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.forms = [
      { id: "frm_10", sessionID: "ses_test1", title: "已经答了", fields: [], state: { status: "answered", answer: { a: "x" } } },
    ]
    clearSent()
    await bridge.reconcilePending()
    expect(sentTexts().length).toBe(0)
  })
})

describe("status", () => {
  test("it reports the queue, the API and the account", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const status = await bridge.describeStatus()
    expect(status).toContain("bot@im.bot")
    expect(status).toContain("本地 API")
    expect(status).toContain("待审批")
  })
})

describe("following the desktop", () => {
  test("/attach binds to the session that is running", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.sessions = [
      { id: "ses_test1", title: "我的会话", location: { directory: "/tmp" }, time: { updated: Date.now() } },
      { id: "ses_running", title: "桌面正在跑的", location: { directory: "D:\\code\\app" }, time: { updated: Date.now() - 1000 } },
      ...DEFAULT_SESSIONS,
    ]
    apiMock.active = ["ses_running"]
    clearSent()

    await bridge.handleInbound(inbound("/attach"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_running")
    expect(sentTexts().join("\n")).toContain("正在运行")
    expect(readState().bindings[CONVERSATION]?.switchedAt).toBeGreaterThan(0)
  })

  test("/attach falls back to the most recently updated session", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/attach"))
    // Nothing is running, so the newest session in the list wins.
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")
  })

  test("/attach with an argument behaves like an explicit switch", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleInbound(inbound("/attach 2"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote2")
    expect(readState().bindings[CONVERSATION]?.switchedAt).toBeGreaterThan(0)
  })

  test("auto-follow moves to the running session and says so", async () => {
    const { bridge, logs } = await harness({ followActive: true })
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.sessions = [
      { id: "ses_test1", title: "我的会话", location: { directory: "/tmp" }, time: { updated: Date.now() } },
      { id: "ses_running", title: "桌面跑着的", location: { directory: "D:\\code\\app" }, time: { updated: Date.now() } },
    ]
    apiMock.active = ["ses_running"]
    clearSent()

    await bridge.followActiveSession()
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_running")
    expect(sentTexts().join("\n")).toContain("已跟随到电脑上正在用的会话")
    expect(logs.some((line) => line.includes("auto-followed"))).toBe(true)
  })

  test("auto-follow respects a recent explicit switch", async () => {
    const { bridge } = await harness({ followActive: true })
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.sessions = [
      { id: "ses_test1", title: "我的会话", location: { directory: "/tmp" }, time: { updated: Date.now() } },
      { id: "ses_running", title: "桌面跑着的", location: { directory: "D:\\code\\app" }, time: { updated: Date.now() } },
    ]
    apiMock.active = ["ses_running"]

    await bridge.handleInbound(inbound("/switch 1"))
    const afterSwitch = readState().bindings[CONVERSATION]?.sessionID
    clearSent()

    await bridge.followActiveSession()
    // The user just said where they want to be; following must not override it.
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe(afterSwitch)
    expect(sentTexts().length).toBe(0)
  })

  test("auto-follow ignores sessions that have been idle for a while", async () => {
    const { bridge } = await harness({ followActive: true, followWindowMs: 1_000 })
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.sessions = [
      {
        id: "ses_stale",
        title: "很久以前",
        location: { directory: "D:\\old" },
        time: { updated: Date.now() - 60 * 60_000 },
      },
    ]
    clearSent()
    await bridge.followActiveSession()
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_test1")
    expect(sentTexts().length).toBe(0)
  })

  test("auto-follow is off by default", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    apiMock.sessions = [
      { id: "ses_running", title: "桌面跑着的", location: { directory: "D:\\code\\app" }, time: { updated: Date.now() } },
    ]
    apiMock.active = ["ses_running"]
    await bridge.followActiveSession()
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_test1")
  })
})

describe("lending a desktop session to the phone", () => {
  test("lendSession binds, records the session, and tells the user", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    const channel = readState().channelSessionID as string
    clearSent()

    const result = await bridge.lendSession("ses_remote1")
    expect(result.ok).toBe(true)
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")
    expect(readState().phoneSessions).toContain("ses_remote1")
    expect(readState().channelSessionID).toBe(channel)
    expect(sentTexts().join("\n")).toContain("已把这个会话接到微信")
  })

  test("releaseSession hands the session back to the home session", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    const channel = readState().channelSessionID as string
    await bridge.lendSession("ses_remote1")
    clearSent()

    const result = await bridge.releaseSession()
    expect(result.ok).toBe(true)
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe(channel)
    expect(sentTexts().join("\n")).toContain("已切回主会话")
  })

  test("lendSession refuses a session that does not exist", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    const result = await bridge.lendSession("ses_missing")
    expect(result.ok).toBe(false)
    expect(result.label).toContain("不存在")
  })

  test("/detach returns to the channel without a desktop involved", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    const channel = readState().channelSessionID as string
    await bridge.handleInbound(inbound("/attach 1"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe("ses_remote1")

    clearSent()
    await bridge.handleInbound(inbound("/detach"))
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe(channel)
    expect(sentTexts().join("\n")).toContain("已切回主会话")
  })

  test("a lent session that disappears falls back to the channel", async () => {
    const { bridge, calls, sessions } = await harness()
    await bridge.handleInbound(inbound("你好"))
    const channel = readState().channelSessionID as string
    await bridge.handleInbound(inbound("/attach 1"))
    sessions.delete("ses_remote1")

    clearSent()
    await bridge.handleInbound(inbound("还在吗"))
    // No new session is invented: the phone goes home.
    expect(calls.creates.length).toBe(1)
    expect(readState().bindings[CONVERSATION]?.sessionID).toBe(channel)
    expect(sentTexts().join("\n")).toContain("回到主会话")
    expect(String(calls.prompts.at(-1)?.text)).toBe("还在吗")
  })

  test("/channel reports the home session", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    clearSent()
    await bridge.handleInbound(inbound("/channel"))
    const text = sentTexts().join("\n")
    expect(text).toContain("主会话")
    expect(text).toContain("当前对话在")
  })

  test("/channel moves the home session by list index", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("你好"))
    clearSent()

    // The numbers come from the list the user just read.
    await bridge.handleInbound(inbound("/list all"))
    await bridge.handleInbound(inbound("/channel 2"))
    expect(readState().channelSessionID).toBe("ses_remote2")
    expect(sentTexts().join("\n")).toContain("设为主会话")
    // …and the new home is remembered on the phone's list.
    expect(readState().phoneSessions).toContain("ses_remote2")
  })
})

describe("mirroring other sessions", () => {
  test("with mirroring on, a session that is not bound still reports to WeChat", async () => {
    const { bridge } = await harness({ mirrorAll: true })
    // Establish a conversation first: mirroring needs somewhere to send.
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_someone_elses", assistantMessageID: "msg_9", ordinal: 0, text: "桌面端跑完了" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_someone_elses" } })
    expect(sentTexts()).toEqual(["桌面端跑完了"])
  })

  test("with mirroring off it stays on the desktop", async () => {
    const { bridge } = await harness({ mirrorAll: false })
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_someone_elses", assistantMessageID: "msg_9", ordinal: 0, text: "桌面端跑完了" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_someone_elses" } })
    expect(sentTexts().length).toBe(0)
  })
})

describe("hardening (audit follow-up)", () => {
  test("a question asked by one instance is answered through shared state", async () => {
    const first = await harness()
    await first.bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    const answer = first.bridge.ask(CONVERSATION, "选哪个？", 5_000)
    await waitFor(() => readState().pendingQuestions?.[CONVERSATION]?.text === "选哪个？", 2_000, "question in state")

    // The instance that owns the poller may be a different one: it records the
    // reply in shared state, and the asking instance resolves by watching it.
    const second = await harness({}, { keepState: true })
    await second.bridge.handleInbound(inbound("选第二个"))
    expect(readState().questionAnswers?.[CONVERSATION]?.text).toBe("选第二个")
    await expect(answer).resolves.toBe("选第二个")
    expect(readState().pendingQuestions?.[CONVERSATION]).toBeUndefined()
  })

  test("stopping the poller preserves an assembled turn", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "重载前的答案" },
    })
    bridge.stopPolling()
    expect(readState().pendingOutbound?.[CONVERSATION] ?? []).toContain("重载前的答案")
  })

  test("a second approval is announced with its real position", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    await bridge.handleEvent({
      type: "permission.asked",
      data: { id: "per_a", sessionID: "ses_test1", action: "bash", resources: ["rm -rf build"] },
    })
    await waitFor(() => sentTexts().length >= 1, 2_000, "first approval")
    await bridge.handleEvent({
      type: "permission.asked",
      data: { id: "per_b", sessionID: "ses_test1", action: "edit", resources: ["src/app.ts"] },
    })
    await waitFor(() => sentTexts().length >= 2, 2_000, "second approval")

    // Numbering must agree with what `/allow <n>` resolves — announcing the new
    // request as "1/1" used to make a bare "1" apply to the *older* one.
    expect(sentTexts().join("\n")).toContain("第 2/2 个待审批")
  })

  test("sendToLast reports a refusal instead of throwing", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    await expect(bridge.sendToLast("发不出去")).resolves.toBe(false)
    ilink.refuseSends = false
  })

  test("a refused send retries without the context token and lands", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    clearSent()

    // The stored reply window has expired: sending with the token is refused,
    // the fallback without it succeeds. This is the self-healing path for a
    // window that closed while the agent was still thinking.
    ilink.refuseContextTokens = true
    try {
      await bridge.handleEvent({
        type: "session.text.ended",
        data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "窗口过期也能发" },
      })
      await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })
      await waitFor(() => sentTexts().length > 0, 2_000, "fallback delivery")
      expect(sentTexts()).toEqual(["窗口过期也能发"])

      const sends = ilink.attempts.filter((entry) => entry.path === "POST /ilink/bot/sendmessage")
      expect(sends.length).toBeGreaterThanOrEqual(2)
      expect((sends[0]!.body.msg as { context_token?: string }).context_token).toBeDefined()
      expect((sends[1]!.body.msg as { context_token?: string }).context_token).toBeUndefined()
    } finally {
      ilink.refuseContextTokens = false
    }
  })

  test("/cancel all leaves nothing of a stuck queue behind", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    ilink.refuseSends = true
    await bridge.handleEvent({
      type: "session.text.ended",
      data: { sessionID: "ses_test1", assistantMessageID: "msg_1", ordinal: 0, text: "卡住的内容" },
    })
    await bridge.handleEvent({ type: "session.idle", data: { sessionID: "ses_test1" } })

    // The window is still shut, so the stuck text survives the inbound flush and
    // `/cancel all` is what removes it.
    await bridge.handleInbound(inbound("/cancel all"))
    const queued = readState().pendingOutbound?.[CONVERSATION] ?? []
    expect(queued).not.toContain("卡住的内容")
    // Both the stuck text and the ⚠️ notice that was queued in front of it.
    expect(queued.join("\n")).toContain("丢弃了 2 条")
    ilink.refuseSends = false
  })

  test("/always and /deny all reach every pending request", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_test1", action: "bash", resources: ["rm -rf build"] },
    })
    await bridge.handleEvent({
      type: "permission.asked",
      data: { id: "per_2", sessionID: "ses_test1", action: "edit", resources: ["src/app.ts"] },
    })
    await waitFor(() => sentTexts().length >= 1, 2_000, "approval announcement")

    await bridge.handleInbound(inbound("/always 2"))
    expect(calls.permissionReplies.at(-1)).toMatchObject({ requestID: "per_2", decision: "always" })

    await bridge.handleInbound(inbound("/deny all"))
    expect(calls.permissionReplies.at(-1)).toMatchObject({ requestID: "per_1", decision: "reject" })
    expect(calls.permissionReplies).toHaveLength(2)
  })

  test("an approval answered elsewhere stops swallowing a bare digit", async () => {
    const { bridge, calls } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_test1", action: "bash", resources: ["rm -rf build"] },
    })
    await waitFor(() => sentTexts().length >= 1, 2_000, "approval announcement")

    // Answered on the desktop: the phone's next "1" is just a message again.
    await bridge.handleEvent({ type: "permission.replied", data: { requestID: "per_1" } })
    clearSent()
    await bridge.handleInbound(inbound("1"))
    expect(calls.permissionReplies).toHaveLength(0)
    expect(calls.prompts.at(-1)?.text).toBe("1")
  })

  test("a form answered elsewhere stops being pending", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    await bridge.handleEvent({
      type: "form.created",
      data: {
        form: {
          id: "frm_gone",
          sessionID: "ses_test1",
          title: "选一个",
          fields: [{ key: "k", title: "问题", type: "string" }],
        },
      },
    })
    await waitFor(() => sentTexts().length >= 1, 2_000, "form prompt")

    await bridge.handleEvent({ type: "form.replied", data: { id: "frm_gone" } })
    clearSent()
    await bridge.handleInbound(inbound("/answer 随便"))
    expect(sentTexts().join("\n")).toContain("没有待回答")
  })

  test("a multiselect submits an array, and an external field is refused", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))

    const created = (id: string, fields: unknown[]) =>
      bridge.handleEvent({ type: "form.created", data: { form: { id, sessionID: "ses_test1", title: "多选", fields } } })

    await created("frm_multi", [
      {
        key: "tags",
        title: "标签",
        type: "multiselect",
        options: [
          { value: "a", label: "甲" },
          { value: "b", label: "乙" },
        ],
      },
      { key: "note", title: "备注", type: "string" },
    ])
    await waitFor(() => sentTexts().length >= 1, 2_000, "form prompt")
    clearSent()
    await bridge.handleInbound(inbound("/answer 1=1,2；2=记一下"))
    expect(apiMock.answered.at(-1)?.answer).toEqual({ tags: ["a", "b"], note: "记一下" })
    expect(sentTexts().join("\n")).toContain("已提交")

    // An external field can only be answered on the desktop; saying so beats
    // submitting a wrong value.
    await created("frm_ext", [{ key: "ext", title: "外部", type: "external" }])
    await waitFor(() => sentTexts().some((text) => text.includes("想问你")), 2_000, "external prompt")
    clearSent()
    await bridge.handleInbound(inbound("/answer 随便"))
    expect(sentTexts().join("\n")).toContain("桌面端处理")
  })

  test("sending a missing file explains itself", async () => {
    const { bridge } = await harness()
    await bridge.handleInbound(inbound("/new 我的会话"))
    const result = await bridge.sendFileToLast({ filePath: join(tmpdir(), "wechat-definitely-missing.bin") })
    expect(result).toContain("文件不存在")
  })
})
