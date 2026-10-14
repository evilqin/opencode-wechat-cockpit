/**
 * opencode ↔ WeChat bridge plugin.
 *
 * Runs inside the OpenCode server, so the bot keeps working while the desktop
 * is locked or the terminal is closed. One instance per loaded location loads
 * this plugin; a lock keeps exactly one of them polling WeChat so an inbound
 * message is never answered twice.
 */

import { Plugin } from "@opencode/plugin"
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"

import { LocalApi } from "./api.ts"
import { Bridge, errorText, renderForWechat } from "./bridge.ts"
import { kindForPath, type OutboundKind } from "./media.ts"
import { readConfig, writeConfig, type WechatConfig } from "./config.ts"
import { ensureStateDir, STATE_DIR } from "./state.ts"
import { login } from "./ilink.ts"

type Ctx = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

/** The shape every logger here shares. */
interface LoggerLike {
  info: (message: string) => void
  warn: (message: string) => void
}

/** Everything the ownership loop needs to do its job. */
export interface OwnershipLoop {
  /** Run one ownership check by hand (the timer calls it too). */
  tick: () => void
  /** Stop the timer and the event subscription. */
  dispose: () => void
}

/**
 * The once-per-interval ownership check.
 *
 * Extracted from `setup` so tests can drive it directly. This loop is where a
 * plugin instance claims the poller slot, keeps the event subscription alive
 * (a stream that ended is resubscribed on the next tick), and picks up config
 * edits written by the desktop commands.
 */
export function createOwnershipLoop(params: {
  ctx: Ctx
  bridge: Bridge
  log: LoggerLike
  intervalMs?: number
}): OwnershipLoop {
  const { ctx, bridge, log } = params
  let stopEvents: (() => void) | undefined
  let disposed = false

  const tick = (): void => {
    if (disposed) return
    try {
      bridge.reloadState()
      bridge.setConfig(readConfig())
      const owned = bridge.tryBecomeOwner()
      if (owned && !stopEvents) {
        stopEvents = subscribeToEvents(ctx, bridge, log, () => {
          // Resubscribe on the next tick (10s): an ended stream used to leave
          // the channel "connected" with no events at all.
          stopEvents = undefined
        })
      } else if (!owned && stopEvents) {
        stopEvents()
        stopEvents = undefined
      }
    } catch (error) {
      log.warn(`ownership tick failed: ${errorText(error)}`)
    }
  }

  const timer = setInterval(tick, params.intervalMs ?? TAKEOVER_INTERVAL_MS)
  timer.unref?.()

  return {
    tick,
    dispose: () => {
      disposed = true
      clearInterval(timer)
      stopEvents?.()
      stopEvents = undefined
    },
  }
}

const LOG_PATH = join(STATE_DIR, "bridge.log")
const LOG_MAX_BYTES = 512 * 1024
/**
 * How often a plugin instance re-checks whether it owns the poller slot.
 *
 * This is also the takeover latency after the previous owner unloads, so it is
 * short enough to feel immediate and long enough to be free.
 */
const TAKEOVER_INTERVAL_MS = 10_000

function makeLogger() {
  const write = (level: string, message: string): void => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      ensureStateDir()
      truncateIfLarge(LOG_PATH)
      appendFileSync(LOG_PATH, line)
    } catch {
      // Logging must never break the bridge.
    }
    if (level === "warn") console.warn(`[wechat] ${message}`)
    else console.log(`[wechat] ${message}`)
  }
  return {
    info: (message: string) => write("info", message),
    warn: (message: string) => write("warn", message),
  }
}

/** Keep the log useful without letting it grow without bound. */
function truncateIfLarge(path: string): void {
  try {
    if (statSync(path).size < LOG_MAX_BYTES) return
    const lines = readFileSync(path, "utf8").split("\n")
    writeFileSync(path, `${lines.slice(-400).join("\n")}\n`)
  } catch {
    // No file yet, or a racing writer: the append below still works.
  }
}

export default Plugin.define({
  id: "wechat",
  async setup(ctx: Ctx) {
    const log = makeLogger()
    const config = readConfig()
    const location = ctx.location?.directory ?? process.cwd()
    const api = new LocalApi()
    const bridge = new Bridge(ctx, config, log, location, api)

    log.info(
      `plugin loaded for ${location} (opencode ${ctx.app?.version ?? "?"}), account=${bridge.account?.accountId ?? "none"}, api=${
        api.available ? (api.isSelf ? "self" : "registered") : "unavailable"
      }`,
    )

    const loop = createOwnershipLoop({ ctx, bridge, log })
    loop.tick()
    if (!bridge.ownsPoller) log.info("another instance already polls WeChat; standing by")

    await registerTools(ctx, bridge, log).catch((error) => log.warn(`tool registration failed: ${errorText(error)}`))
    await registerCommands(ctx, bridge, log).catch((error) => log.warn(`command registration failed: ${errorText(error)}`))

    return () => {
      loop.dispose()
      void bridge.announceStop()
      bridge.releaseOwnership()
      log.info("plugin unloaded")
    }
  },
})

function subscribeToEvents(
  ctx: Ctx,
  bridge: Bridge,
  log: { warn: (message: string) => void },
  onEnd: () => void,
): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await bridge.handleEvent(event as { type?: string; data?: unknown })
        } catch (error) {
          log.warn(`event handling failed: ${errorText(error)}`)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) log.warn(`event stream ended: ${errorText(error)}`)
    } finally {
      // The stream ended on its own: tell the ownership tick so it resubscribes.
      // Otherwise the poller keeps running while answers, approvals and
      // questions silently stop reaching the phone until a manual reload.
      if (!controller.signal.aborted) onEnd()
    }
  })()
  return () => controller.abort()
}

/** Tools the agent can call to reach the user proactively. */
async function registerTools(ctx: Ctx, bridge: Bridge, log: { warn: (message: string) => void }): Promise<void> {
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "wechat_send",
      description:
        "主动给微信发一条消息。适合长任务跑完、需要用户决策、或用户离开电脑时汇报结果。想连带发文件就填 file。",
      input: {
        type: "object",
        properties: {
          text: { type: "string", description: "要发送的正文（可留空，只要发文件时）" },
          file: { type: "string", description: "可选：要一起发送的本地文件绝对路径" },
        },
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const record = (input ?? {}) as { text?: string; file?: string }
        const text = String(record.text ?? "").trim()
        const file = String(record.file ?? "").trim()
        if (!text && !file) return { content: "没有可发送的内容" }

        bridge.reloadState()
        if (!bridge.account?.token) return { content: "微信通道尚未登录：先在电脑上执行 /wechat-login" }

        try {
          if (file) {
            const result = await bridge.sendFileToLast({
              filePath: file,
              caption: text || undefined,
              kind: kindForPath(file),
            })
            return { content: result }
          }
          const ok = await bridge.sendToLast(renderForWechat(text))
          return { content: ok ? "已发送到微信" : "发送失败：微信可能已关闭回复窗口，等用户先说句话再试" }
        } catch (error) {
          log.warn(`wechat_send failed: ${errorText(error)}`)
          return { content: `发送失败：${errorText(error)}` }
        }
      },
    })

    editor.add({
      name: "wechat_send_file",
      description:
        "把一个本地文件或图片发到微信：图片/视频会作为原生图片/视频显示，其他文件作为文件卡片。适合把改动结果、截图、报告发给用户。",
      input: {
        type: "object",
        properties: {
          path: { type: "string", description: "本地文件绝对路径" },
          caption: { type: "string", description: "可选：附带的说明文字" },
          kind: { type: "string", description: "可选：image | video | file，默认按扩展名判断" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const record = (input ?? {}) as { path?: string; caption?: string; kind?: string }
        const filePath = String(record.path ?? "").trim()
        if (!filePath) return { content: "缺少 path" }
        bridge.reloadState()
        if (!bridge.account?.token) return { content: "微信通道尚未登录：先在电脑上执行 /wechat-login" }
        const resolved = isAbsolute(filePath) ? filePath : resolvePath(filePath)
        const kind =
          record.kind === "image" || record.kind === "video" || record.kind === "file"
            ? (record.kind as OutboundKind)
            : kindForPath(resolved)
        const result = await bridge.sendFileToLast({ filePath: resolved, caption: record.caption, kind })
        return { content: result }
      },
    })

    editor.add({
      name: "wechat_ask",
      description:
        "在微信里向用户提问，并等待他回答后再继续。适用于必须由人拍板的事（选哪个方案、要不要继续、要不要发布）。用户不回答会超时返回，不会永久卡住。",
      input: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问的问题，尽量短且可一句话回答" },
          timeoutMinutes: { type: "integer", description: "等待分钟数，默认用配置值（10 分钟）" },
        },
        required: ["question"],
        additionalProperties: false,
      },
      execute: async (input: unknown) => {
        const record = (input ?? {}) as { question?: string; timeoutMinutes?: number }
        const question = String(record.question ?? "").trim()
        if (!question) return { content: "缺少 question" }

        bridge.reloadState()
        const conversationId = bridge.lastConversation
        if (!conversationId) return { content: "还没有微信会话：先让用户在微信里发一条消息" }
        if (!bridge.account?.token) return { content: "微信通道尚未登录" }

        const timeoutMs =
          typeof record.timeoutMinutes === "number" && record.timeoutMinutes > 0
            ? record.timeoutMinutes * 60_000
            : bridge.config.askTimeoutMs
        const answer = await bridge.ask(conversationId, question, timeoutMs)
        return { content: `用户的回答：${answer}` }
      },
    })

    editor.add({
      name: "wechat_status",
      description: "查看微信通道状态：登录、轮询、本地 API、待审批/待回答数量、会话数。",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        bridge.reloadState()
        return { content: await bridge.describeStatus() }
      },
    })
  })
}

/** TUI-side helpers: `/wechat-login`, `/wechat-status`, `/wechat-config`. */
async function registerCommands(ctx: Ctx, bridge: Bridge, log: { info: (m: string) => void; warn: (m: string) => void }) {
  await ctx.command.transform((editor) => {
    editor.add({
      name: "wechat-login",
      description: "扫码登录微信 ClawBot 通道（二维码会发到当前会话里）",
      execute: async ({ sessionID }) => {
        const say = async (text: string) => {
          await ctx.session.synthetic({ sessionID, text }).catch(() => {})
        }
        const existing = bridge.account?.token ? [bridge.account.token] : []
        if (bridge.account?.token) {
          await say(`已经登录过：${bridge.account.accountId}\n重新扫码会覆盖现有绑定，正在生成二维码…`)
        }
        void login({
          existingTokens: existing,
          onEventError: (error) => log.warn(`login event handler failed: ${errorText(error)}`),
          onEvent: async (event) => {
            switch (event.kind) {
              case "qr": {
                const png = await writeQrPng(event.qrUrl)
                const ascii = await renderQr(event.qrUrl)
                await say(
                  [
                    "用微信扫描下面的二维码并在手机上确认：",
                    "",
                    ascii ?? "（这里显示不了二维码，用下面的图片路径）",
                    "",
                    png ? `图片版：${png}` : "",
                    `二维码链接：${event.qrUrl}`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                )
                break
              }
              case "scanned":
                await say("已扫码，请在手机上点击确认。")
                break
              case "already-bound":
                await say("服务端回复该账号已经绑定过 bot。若通道仍然不可用，请用同一账号重新登录一次。")
                break
              case "verifycode-required":
                await say("服务端要求输入配对验证码，这一步只能在终端里完成：请运行状态目录下的 login-cli.ts。")
                break
              case "expired":
                await say(event.willRetry ? "二维码过期，正在刷新。" : "二维码反复过期，请稍后再试。")
                break
              case "confirmed":
                bridge.saveAccount(event.account)
                bridge.reloadState()
                await say(`✅ 登录成功：${event.account.accountId}\n现在可以直接在微信里给我发消息。`)
                log.info(`login confirmed for ${event.account.accountId}`)
                break
              case "failed":
                await say(`❌ 登录失败：${event.reason}`)
                break
              default:
                break
            }
          },
        }).catch((error) => void say(`❌ 登录流程出错：${errorText(error)}`))
      },
    })

    editor.add({
      name: "wechat-attach",
      description: "把这个会话接到微信（手机上发消息会进这里；等价于微信里的 /attach）",
      execute: async ({ sessionID }) => {
        bridge.reloadState()
        const result = await bridge.lendSession(sessionID)
        await ctx.session
          .synthetic({ sessionID, text: result.ok ? `📱 已接到微信：${result.title ?? sessionID}` : `📱 ${result.message ?? result.label}` })
          .catch(() => {})
      },
    })

    editor.add({
      name: "wechat-detach",
      description: "把会话还给电脑：手机切回主会话，本会话的消息不再推送到微信",
      execute: async ({ sessionID }) => {
        bridge.reloadState()
        const result = await bridge.releaseSession()
        await ctx.session
          .synthetic({ sessionID, text: result.ok ? "↩️ 已切回主会话" : `📱 ${result.message ?? result.label}` })
          .catch(() => {})
      },
    })

    editor.add({
      name: "wechat-status",
      description: "查看微信通道状态",
      execute: async ({ sessionID }) => {
        bridge.reloadState()
        await ctx.session.synthetic({ sessionID, text: await bridge.describeStatus() }).catch(() => {})
      },
    })

    editor.add({
      name: "wechat-config",
      description: "查看或修改微信通道设置（进度提示、实时推送、默认目录、白名单…）",
      execute: async ({ sessionID, prompt }) => {
        const argument = (prompt?.text ?? "").trim()
        const current = readConfig()
        if (!argument) {
          await ctx.session
            .synthetic({
              sessionID,
              text: [
                describeConfig(current, bridge.defaultDirectory),
                "",
                "用法：",
                "  /wechat-config progress off|tools",
                "  /wechat-config stream off|live",
                "  /wechat-config stream-interval <秒>",
                "  /wechat-config grace <毫秒>（0 = 文本一结束就发；默认 3000）",
                "  /wechat-config dir <路径>",
                "  /wechat-config mirror on|off",
                "  /wechat-config follow on|off",
                "  /wechat-config follow-hold <分钟>",
                "  /wechat-config autotitle on|off",
                "  /wechat-config ack off|text",
                "  /wechat-config chunk <字符数>",
                "  /wechat-config list <条数>",
                "  /wechat-config agent <agent id>",
                "  /wechat-config model <providerID/modelID>",
                "  /wechat-config allow <微信id|self|clear>",
                "  /wechat-config delay <毫秒>",
                "  /wechat-config ask <分钟>",
                "  /wechat-config burst <毫秒>",
              ].join("\n"),
            })
            .catch(() => {})
          return
        }

        const [key, ...rest] = argument.split(/\s+/)
        const value = rest.join(" ").trim()
        const next: WechatConfig = { ...current }
        switch (key) {
          case "progress":
            next.progress = value === "off" ? "off" : "tools"
            break
          case "stream":
            next.stream = value === "live" ? "live" : "off"
            break
          case "stream-interval": {
            const seconds = Number.parseInt(value, 10)
            if (Number.isFinite(seconds) && seconds >= 1) next.streamIntervalMs = seconds * 1000
            break
          }
          case "grace": {
            const ms = Number.parseInt(value, 10)
            if (Number.isFinite(ms) && ms >= 0) next.turnGraceMs = ms
            break
          }
          case "dir":
            next.directory = value || current.directory
            break
          case "mirror":
            next.mirrorAll = value === "on"
            break
          case "follow":
            next.followActive = value !== "off"
            break
          case "follow-hold": {
            const minutes = Number.parseInt(value, 10)
            if (Number.isFinite(minutes) && minutes >= 0) next.followHoldMs = minutes * 60_000
            break
          }
          case "autotitle":
            next.autoTitle = value !== "off"
            break
          case "ack":
            next.ack = value === "text" ? "text" : "off"
            break
          case "chunk": {
            const size = Number.parseInt(value, 10)
            // Clamp to the service's own per-message limit: a larger value would
            // make every long reply lose its tail on the phone.
            if (Number.isFinite(size) && size >= 200) next.chunkSize = Math.min(size, 4_000)
            break
          }
          case "list": {
            const size = Number.parseInt(value, 10)
            if (Number.isFinite(size) && size > 0) next.listLimit = size
            break
          }
          case "agent":
            next.agent = value
            break
          case "model":
            next.model = value
            break
          case "delay": {
            const ms = Number.parseInt(value, 10)
            if (Number.isFinite(ms) && ms >= 0) next.sendDelayMs = ms
            break
          }
          case "ask": {
            const minutes = Number.parseInt(value, 10)
            if (Number.isFinite(minutes) && minutes >= 1) next.askTimeoutMs = minutes * 60_000
            break
          }
          case "burst": {
            const ms = Number.parseInt(value, 10)
            if (Number.isFinite(ms) && ms >= 0) next.approvalBurstMs = ms
            break
          }
          case "allow": {
            if (value === "clear") next.allowedUsers = []
            else if (value) next.allowedUsers = [...new Set([...current.allowedUsers, value])]
            break
          }
          default:
            await ctx.session.synthetic({ sessionID, text: `未知设置项：${key}` }).catch(() => {})
            return
        }

        writeConfig(next)
        bridge.setConfig(next)
        await ctx.session.synthetic({ sessionID, text: describeConfig(next, bridge.defaultDirectory) }).catch(() => {})
      },
    })
  })
  log.info("commands registered: /wechat-login /wechat-attach /wechat-detach /wechat-status /wechat-config")
}

function describeConfig(config: WechatConfig, directory: string): string {
  return [
    "微信通道设置：",
    `进度提示：${config.progress === "tools" ? "显示工具调用" : "关闭"}（progress）`,
    `实时推送：${config.stream === "live" ? `开，每 ${Math.round(config.streamIntervalMs / 1000)} 秒` : "关"}（stream）`,
    `回复延迟：文本结束后最多等 ${config.turnGraceMs} 毫秒（grace）`,
    `默认目录：${directory}${directory === config.directory ? "" : "（/dir 覆盖）"}（dir）`,
    `镜像其他会话：${config.mirrorAll ? "开" : "关"}（mirror）`,
    `自动跟随：${config.followActive ? "开" : "关"}（follow，手动切换后 ${Math.round(config.followHoldMs / 60_000)} 分钟内不打扰）`,
    `自动命名：${config.autoTitle ? "开" : "关"}（autotitle）`,
    `收到确认：${config.ack === "text" ? "开" : "关"}（ack）`,
    `分片大小：${config.chunkSize}（chunk）`,
    `列表条数：${config.listLimit}（list）`,
    `发送间隔：${config.sendDelayMs}ms（delay）`,
    `新会话 agent：${config.agent || "默认"}（agent）`,
    `新会话模型：${config.model || "默认"}（model）`,
    `提问等待：${Math.round(config.askTimeoutMs / 60_000)} 分钟（ask）`,
    `审批合并窗口：${config.approvalBurstMs}ms（burst）`,
    `白名单：${config.allowedUsers.join(", ") || "仅绑定用户"}（allow）`,
  ].join("\n")
}

/** Write a scannable PNG next to the state file. Returns the path, or undefined. */
async function writeQrPng(payload: string): Promise<string | undefined> {
  const target = join(STATE_DIR, "qr.png")
  try {
    const mod = (await import("qrcode")) as unknown as {
      default?: { toFile: (p: string, t: string, o?: unknown) => Promise<void> }
      toFile?: (p: string, t: string, o?: unknown) => Promise<void>
    }
    const renderer = mod.default ?? mod
    if (typeof renderer?.toFile !== "function") return undefined
    await renderer.toFile(target, payload, { width: 640, margin: 2 })
    return target
  } catch {
    return undefined
  }
}

/** Best-effort ASCII QR for the TUI. Falls back to the raw link. */
async function renderQr(payload: string): Promise<string | undefined> {
  try {
    // Loaded lazily: a missing optional dependency must not stop the plugin loading.
    const mod = (await import("qrcode-terminal")) as unknown as {
      default?: { generate: (t: string, o: unknown, cb: (qr: string) => void) => void }
      generate?: (t: string, o: unknown, cb: (qr: string) => void) => void
    }
    const renderer = mod.default ?? mod
    if (typeof renderer?.generate !== "function") return undefined
    let out = ""
    renderer.generate(payload, { small: true }, (qr: string) => {
      out = qr
    })
    return out || undefined
  } catch {
    return undefined
  }
}



























