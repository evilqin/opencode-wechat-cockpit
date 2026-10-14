/**
 * Plugin-entry tests (`index.ts`).
 *
 * This file owns the ownership tick, the event subscription and its resubscribe
 * after the stream ends, the four agent tools and the five desktop commands.
 * None of it had coverage before — and a broken resubscribe silently stops
 * answers, approvals and questions from reaching the phone while the poller
 * keeps running, which is exactly the failure class the resubscribe fixed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"

import { LocalApi } from "../api.ts"
import { Bridge } from "../bridge.ts"
import { CONFIG_PATH, readConfig } from "../config.ts"
import { LOCK_PATH, STATE_DIR, STATE_PATH } from "../state.ts"

// The host package only exists inside opencode; the entry point needs exactly
// one thing from it.
mock.module("@opencode/plugin", () => ({ Plugin: { define: (plugin: unknown) => plugin } }))

const wechatPlugin = (await import("../index.ts")).default as unknown as {
  id: string
  setup: (ctx: never) => Promise<() => void>
}
const { createOwnershipLoop } = await import("../index.ts")

interface FakeStream extends AsyncIterator<unknown> {
  push: (event: unknown) => void
  end: () => void
}

/** An event stream the test can end, to prove the loop resubscribes. */
function makeStream(): FakeStream {
  const pending: unknown[] = []
  let wake: (() => void) | undefined
  let finished = false
  return {
    push(event) {
      pending.push(event)
      wake?.()
    },
    end() {
      finished = true
      wake?.()
    },
    async next() {
      while (pending.length === 0 && !finished) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      if (pending.length > 0) return { value: pending.shift(), done: false }
      return { value: undefined, done: true }
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

interface FakeContext {
  ctx: never
  tools: Array<{ name: string; execute: (input: unknown) => Promise<{ content: string }> }>
  commands: Array<{ name: string; execute: (input: { sessionID: string; prompt?: { text?: string } }) => Promise<void> }>
  synthetics: string[]
  streams: FakeStream[]
  subscribed: () => number
}

function makeContext(): FakeContext {
  const tools: FakeContext["tools"] = []
  const commands: FakeContext["commands"] = []
  const synthetics: string[] = []
  const streams: FakeStream[] = []
  let subscribed = 0

  const ctx = {
    app: { name: "opencode", version: "test" },
    location: { directory: STATE_DIR, project: { id: "proj" } },
    options: {},
    session: {
      create: async () => ({ id: "ses_new" }),
      get: async () => undefined,
      update: async () => undefined,
      prompt: async () => ({ id: "msg" }),
      synthetic: async ({ text }: { text: string }) => {
        synthetics.push(String(text))
        return { id: "msg_synthetic" }
      },
      interrupt: async () => undefined,
      switchModel: async () => undefined,
      switchAgent: async () => undefined,
      remove: async () => undefined,
    },
    model: { list: async () => [], default: async () => undefined },
    agent: { list: async () => [] },
    permission: { reply: async () => undefined },
    event: {
      subscribe: () => {
        subscribed += 1
        const stream = makeStream()
        streams.push(stream)
        return { [Symbol.asyncIterator]: () => stream }
      },
    },
    tool: {
      transform: async (fn: (editor: { add: (def: never) => void }) => void) => {
        fn({ add: (def) => tools.push(def as unknown as FakeContext["tools"][number]) })
        return { dispose: async () => undefined }
      },
      list: async () => [],
      reload: async () => undefined,
    },
    command: {
      transform: async (fn: (editor: { add: (def: never) => void }) => void) => {
        fn({ add: (def) => commands.push(def as unknown as FakeContext["commands"][number]) })
        return { dispose: async () => undefined }
      },
    },
  }

  return { ctx: ctx as never, tools, commands, synthetics, streams, subscribed: () => subscribed }
}

const silentLog = { info: () => undefined, warn: () => undefined }

beforeEach(() => {
  // Every test starts from an empty channel: no config, no bindings, no lock.
  rmSync(CONFIG_PATH, { force: true })
  rmSync(STATE_PATH, { force: true })
  rmSync(LOCK_PATH, { force: true })
})

describe("plugin entry", () => {
  test("setup registers the four tools and the five desktop commands", async () => {
    const fake = makeContext()
    const dispose = await wechatPlugin.setup(fake.ctx)
    try {
      expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
        "wechat_ask",
        "wechat_send",
        "wechat_send_file",
        "wechat_status",
      ])
      expect(fake.commands.map((command) => command.name).sort()).toEqual([
        "wechat-attach",
        "wechat-config",
        "wechat-detach",
        "wechat-login",
        "wechat-status",
      ])
    } finally {
      dispose()
    }
  })

  test("an ended event stream is resubscribed on the next tick", async () => {
    const fake = makeContext()
    const bridge = new Bridge(fake.ctx, readConfig(), silentLog, STATE_DIR, new LocalApi())
    const loop = createOwnershipLoop({ ctx: fake.ctx, bridge, log: silentLog, intervalMs: 20 })
    try {
      loop.tick()
      expect(fake.subscribed()).toBe(1)

      // The stream dies (server upgrade, transport hiccup): the next tick must
      // subscribe again, or events stop arriving for the rest of the process.
      fake.streams[0]!.end()
      await waitFor(() => fake.subscribed() === 2, 2_000, "resubscribe")
    } finally {
      loop.dispose()
      bridge.releaseOwnership()
    }
  })

  test("/wechat-config clamps the chunk size to the service limit", async () => {
    const fake = makeContext()
    const dispose = await wechatPlugin.setup(fake.ctx)
    try {
      const config = fake.commands.find((command) => command.name === "wechat-config")!
      await config.execute({ sessionID: "ses_x", prompt: { text: "chunk 9000" } })
      // A chunk larger than the service limit loses the tail of every reply.
      expect(readConfig().chunkSize).toBe(4_000)
      expect(fake.synthetics.join("\n")).toContain("分片大小")
    } finally {
      dispose()
    }
  })

  test("/wechat-config reports the effective directory and rejects unknown keys", async () => {
    const fake = makeContext()
    const dispose = await wechatPlugin.setup(fake.ctx)
    try {
      const config = fake.commands.find((command) => command.name === "wechat-config")!

      await config.execute({ sessionID: "ses_x", prompt: { text: "" } })
      expect(fake.synthetics.at(-1)).toContain("微信通道设置")
      expect(fake.synthetics.at(-1)).toContain("默认目录")

      await config.execute({ sessionID: "ses_x", prompt: { text: "nonsense 1" } })
      expect(fake.synthetics.at(-1)).toContain("未知设置项")
    } finally {
      dispose()
    }
  })

  test("the tools explain what is missing instead of failing silently", async () => {
    const fake = makeContext()
    const dispose = await wechatPlugin.setup(fake.ctx)
    try {
      const status = await fake.tools.find((tool) => tool.name === "wechat_status")!.execute({})
      expect(status.content).toContain("opencode 微信通道")

      // No account in the state: sending must say so rather than pretend.
      const send = await fake.tools.find((tool) => tool.name === "wechat_send")!.execute({ text: "hi" })
      expect(send.content).toContain("尚未登录")

      // No conversation yet: asking has nowhere to go.
      const ask = await fake.tools.find((tool) => tool.name === "wechat_ask")!.execute({ question: "在吗" })
      expect(ask.content).toContain("还没有微信会话")

      const file = await fake.tools.find((tool) => tool.name === "wechat_send_file")!.execute({})
      expect(file.content).toContain("缺少 path")
    } finally {
      dispose()
    }
  })

  test("dispose releases the poller lock and stops the tick", async () => {
    const fake = makeContext()
    const dispose = await wechatPlugin.setup(fake.ctx)
    expect(existsSync(LOCK_PATH)).toBe(true)
    dispose()
    await waitFor(() => !existsSync(LOCK_PATH), 2_000, "lock release")
  })
})
