/**
 * Terminal login for the WeChat channel.
 *
 *   bun ~/.config/opencode/plugins/wechat/login-cli.ts          # 扫码登录
 *   bun ~/.config/opencode/plugins/wechat/login-cli.ts --status # 查看当前绑定
 *   bun ~/.config/opencode/plugins/wechat/login-cli.ts --logout # 清除本地凭据
 *
 * The plugin itself cannot render a QR code (it runs inside the OpenCode
 * server), but it does not need to: the credentials are written to the shared
 * state file, and every plugin instance picks them up from disk.
 */

import { createInterface } from "node:readline"
import { join } from "node:path"
import { login, sleep } from "./ilink.ts"
import {
  acquireLoginLock,
  readState,
  removeQrPng,
  updateState,
  STATE_DIR,
  STATE_PATH,
  LOCK_PATH,
} from "./state.ts"
import { readConfig } from "./config.ts"

const args = new Set(process.argv.slice(2))

async function renderQr(payload: string): Promise<string | undefined> {
  try {
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

/** Write a scannable PNG next to the state file. Returns the path, or undefined. */
async function writeQrPng(payload: string): Promise<string | undefined> {
  const target = process.env.WECHAT_QR_PNG ?? join(STATE_DIR, "qr.png")
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

/**
 * Ask for the pairing verification code.
 *
 * Resolves `undefined` when stdin ends or nothing arrives within a minute.
 * Without that, a piped or closed stdin left this promise pending forever, and
 * the login's own 5-minute deadline could never fire while it was awaiting.
 */
function ask(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return Promise.resolve(undefined)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolveText) => {
    let settled = false
    const finish = (answer: string | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      resolveText(answer)
    }
    const timer = setTimeout(() => {
      console.log("\n（等待验证码超时，按放弃处理）")
      finish(undefined)
    }, 60_000)
    timer.unref?.()
    rl.on("close", () => finish(undefined))
    rl.question(question, (answer) => finish(answer.trim() || undefined))
  })
}

async function main(): Promise<void> {
  if (args.has("--help") || args.has("-h")) {
    console.log("用法：bun login-cli.ts [--status|--logout|--purge|--force]")
    return
  }

  if (args.has("--status")) {
    const state = readState()
    const config = readConfig()
    console.log("状态文件：", STATE_PATH)
    console.log("锁文件：  ", LOCK_PATH)
    console.log("机器人：  ", state.account?.accountId ?? "未登录")
    console.log("绑定微信：", state.account?.userId ?? "未知")
    console.log("服务端：  ", state.account?.baseUrl ?? "未知")
    console.log("登录时间：", state.account?.savedAt ?? "未知")
    console.log("默认目录：", state.defaultDirectory ?? config.directory)
    console.log("会话数：  ", Object.keys(state.bindings).length)
    return
  }

  if (args.has("--logout")) {
    const state = readState()
    if (!state.account) {
      console.log("当前没有登录信息。")
      removeQrPng()
      return
    }
    updateState((draft) => {
      // The token itself is not a credential to keep, but the server needs it to
      // recognise the binding on the *next* login: dropping it entirely made the
      // next scan create a second bot identity instead of reusing this one.
      const kept = [draft.account?.token, ...(draft.previousTokens ?? [])].filter(
        (token): token is string => Boolean(token),
      )
      draft.previousTokens = [...new Set(kept)].slice(0, 3)
      draft.account = undefined
      draft.syncBuf = undefined
    })
    // A stale QR image is a credential: it must not outlive the login it belongs to.
    removeQrPng()
    console.log("已清除本地凭据（状态文件里的 token 已删除，只保留用于重新绑定的旧 token）。")
    console.log("opencode 最多 10 秒内会停止轮询；重新扫码会复用同一个绑定。")
    console.log("想彻底清空（连旧 token 也不留）：bun login-cli.ts --purge")
    return
  }

  if (args.has("--purge")) {
    updateState((draft) => {
      draft.account = undefined
      draft.previousTokens = []
      draft.syncBuf = undefined
    })
    removeQrPng()
    console.log("已彻底清除本地凭据与旧 token；下次扫码会创建新的绑定。")
    return
  }

  const state = readState()
  if (state.account?.token && !args.has("--force")) {
    console.log(`已经登录：${state.account.accountId}（绑定微信 ${state.account.userId ?? "未知"}）`)
    console.log("重新扫码会替换本地凭据；确实要重新登录请加 --force。")
    return
  }

  const existingTokens = [...new Set([
    ...(state.previousTokens ?? []),
    ...(state.account?.token ? [state.account.token] : []),
  ])]
  // One login at a time: two concurrent QR flows race for the same state file
  // and orphan one of the two bindings the server creates.
  const releaseLogin = acquireLoginLock()
  if (!releaseLogin) {
    console.log("已经有一个登录流程在进行（可能是另一个终端窗口，或 opencode 里的 /wechat-login）。")
    console.log("等它结束再试；如果确定没有别的流程，删掉状态目录里的 login.lock 即可。")
    process.exitCode = 1
    return
  }
  try {
    const result = await login({
      existingTokens,
    onEventError: (error) => {
      console.error("登录事件处理出错：", error instanceof Error ? error.message : String(error))
    },
    onEvent: async (event) => {
      switch (event.kind) {
        case "qr": {
          const ascii = await renderQr(event.qrUrl)
          const png = await writeQrPng(event.qrUrl)
          console.log(event.refreshed ? "\n二维码已刷新：" : "\n用微信扫描下面的二维码：")
          console.log(ascii ?? `（无法渲染二维码，请把下面的链接转成二维码）\n${event.qrUrl}`)
          if (png) console.log(`图片版（手机直接扫这个）：${png}`)
          console.log(`链接：${event.qrUrl}`)
          break
        }
        case "scanned":
          console.log("已扫码，请在手机上点击确认…")
          break
        case "redirected":
          console.log(`服务端把连接切到 ${event.host}，继续轮询…`)
          break
        case "expired":
          console.log(event.willRetry ? "二维码过期，正在刷新…" : "二维码反复过期，请稍后重试。")
          break
        case "already-bound":
          console.log("该账号已经绑定过 bot，本地将复用它。")
          break
        case "confirmed":
          console.log(`\n✅ 登录成功：${event.account.accountId}`)
          break
        case "failed":
          console.log(`\n❌ 登录失败：${event.reason}`)
          break
        default:
          break
      }
    },
    requestVerifyCode: async (attempt) => ask(`服务端要求输入配对验证码（第 ${attempt} 次），直接回车放弃：`),
  })

    if (result.account) {
      updateState((draft) => {
        draft.account = result.account
        draft.syncBuf = undefined
      })
      console.log(`凭据已保存到 ${STATE_PATH}。`)
      console.log("现在可以在微信里给这个机器人发消息了；opencode 正在运行时会在几秒内接上。")
      if (result.alreadyBound) {
        console.log("提示：服务端报告该账号此前已绑定，本次沿用了原绑定。")
      }
      return
    }

    if (result.alreadyBound) {
      if (readState().account?.token) {
        console.log("服务端报告该账号已绑定到现有 bot，本地凭据仍然可用。")
        return
      }
      // The binding lives on the server but this machine holds no credential for
      // it: reporting success here is how a "logged in" channel ends up dead.
      console.log("服务端报告该账号已绑定到某个 bot，但本机没有对应凭据。")
      console.log("如果绑定在另一台机器上：先在那台机器执行 --logout，再回来扫码。")
      process.exitCode = 1
      return
    }

    console.log(`未完成登录：${result.reason ?? "未知原因"}`)
    await sleep(200)
    process.exitCode = 1
  } finally {
    // Both the lock and the QR bitmap are credentials: neither may outlive the
    // flow that created them.
    releaseLogin()
    removeQrPng()
  }
}

main().catch((error) => {
  console.error("登录流程异常：", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
