/**
 * Health check for the WeChat bridge.
 *
 *   bun verify.ts
 *
 * Prints what is configured, what is reachable, and what is likely broken —
 * the same information a person would otherwise have to assemble from three log
 * files. Exits non-zero when something needs attention, so it can be wired into
 * a script if desired.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { CONFIG_PATH, readConfig } from "./config.ts"
import { LOCK_PATH, STATE_DIR, STATE_PATH, readState } from "./state.ts"
import { LocalApi } from "./api.ts"
import { registrationPaths } from "./api.ts"

const problems: string[] = []
const notes: string[] = []

function line(label: string, value: string): void {
  console.log(`${label.padEnd(14, " ")} ${value}`)
}

async function main(): Promise<void> {
  console.log("opencode 微信通道自检\n")

  /* ---- files ---- */
  line("状态目录", STATE_DIR)
  line("状态文件", existsSync(STATE_PATH) ? `存在（${statSync(STATE_PATH).size} 字节）` : "不存在（还没登录）")
  line("配置文件", existsSync(CONFIG_PATH) ? "存在" : "不存在（用默认值）")
  if (!existsSync(STATE_PATH)) problems.push("还没登录：运行 bun login-cli.ts 扫码")

  /* ---- dependencies ---- */
  for (const dependency of ["qrcode", "qrcode-terminal"]) {
    try {
      await import(dependency)
      line(`依赖 ${dependency}`, "可用")
    } catch {
      line(`依赖 ${dependency}`, "缺失")
      problems.push(`缺少依赖 ${dependency}：在 ~/.config/opencode 下执行 bun install`)
    }
  }

  /* ---- login ---- */
  const state = readState()
  const account = state.account
  if (account) {
    line("机器人", account.accountId)
    line("绑定微信", account.userId ?? "未知")
    line("服务端", account.baseUrl)
    line("token", account.token ? `已保存（${account.token.length} 字符）` : "已被清空（需要重新登录）")
    if (!account.token) problems.push("token 已失效：重新运行 login-cli.ts 扫码")
    line("登录时间", account.savedAt ?? "未知")
    line("长轮询游标", state.syncBuf ? "已保存" : "空（下次从服务端默认位置开始）")
  } else {
    line("机器人", "未登录")
  }

  /* ---- config ---- */
  const config = readConfig()
  line("默认目录", config.directory)
  if (!existsSync(config.directory)) problems.push(`默认目录不存在：${config.directory}（用 /dir 改）`)
  line("进度提示", config.progress === "tools" ? "显示工具调用" : "关闭")
  line("实时推送", config.stream === "live" ? `开（${config.streamIntervalMs / 1000}s）` : "关")
  line("回复延迟", `${config.turnGraceMs}ms（文本结束到发送的最长等待）`)
  line("白名单", config.allowedUsers.length ? config.allowedUsers.join(", ") : "仅绑定用户")
  line("新会话模型", config.model || "跟随默认")
  line("新会话 agent", config.agent || "跟随默认")

  /* ---- lock ---- */
  if (existsSync(LOCK_PATH)) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as {
        pid: number
        location: string
        heartbeat: number
        polledAt?: number
      }
      const ageSeconds = Math.round((Date.now() - lock.heartbeat) / 1000)
      const pollAge =
        typeof lock.polledAt === "number" ? Math.round((Date.now() - lock.polledAt) / 1000) : undefined
      line(
        "轮询锁",
        `pid=${lock.pid} ${lock.location}（心跳 ${ageSeconds} 秒前${
          pollAge === undefined ? "，未记录轮询时间" : `，上次完成长轮询 ${pollAge} 秒前`
        }）`,
      )
      if (ageSeconds > 120) notes.push("轮询锁看起来已经过期，下次 tick（10 秒内）会被自动接管")
      else if (pollAge !== undefined && pollAge > 120) {
        notes.push("锁的心跳在跑但很久没有完成过长轮询：另一个实例会在 2 分钟内接管并重启它")
      }
    } catch {
      line("轮询锁", "存在但无法解析（会被自动清理）")
    }
  } else {
    line("轮询锁", "无人持有（opencode 没在跑，或插件还没加载）")
    notes.push("opencode 服务没在运行时，微信消息会留在腾讯服务端，等它重连后按游标补发")
  }

  /* ---- local API ---- */
  const api = new LocalApi({ cacheMs: 0 })
  line("注册文件", registrationPaths().filter((path) => existsSync(path)).join(", ") || "找不到")
  const info = await api.info()
  if (info) {
    line("本地 API", `可用 v${info.version ?? "?"} ${info.url ?? ""}`)
    const sessions = await api.listSessions({ limit: 3 })
    line("会话可见", `最近 ${sessions.length} 个（/list 用得到）`)
    notes.push("自检是独立进程，所以永远不是「本进程」；插件在 opencode 服务里运行时会自己认出来")
  } else {
    line("本地 API", "不可用")
    notes.push("本地 API 不可用时：/list 只列微信建过的会话，agent 的提问需要回电脑回答")
  }

  /* ---- log ---- */
  const logPath = join(STATE_DIR, "bridge.log")
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean)
    const warnings = lines.filter((entry) => entry.includes(" warn ")).slice(-3)
    line("最近日志", `${lines.length} 行`)
    for (const warning of warnings) console.log(`               ${warning.slice(0, 160)}`)
  } else {
    line("最近日志", "还没有日志（插件还没加载过）")
  }

  console.log("")
  if (notes.length) {
    console.log("提示：")
    for (const note of notes) console.log(`  · ${note}`)
    console.log("")
  }
  if (problems.length) {
    console.log("需要处理：")
    for (const problem of problems) console.log(`  ✗ ${problem}`)
    process.exitCode = 1
    return
  }
  console.log("✅ 没发现明显问题。")
}

main().catch((error) => {
  console.error("自检本身出错了：", error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
