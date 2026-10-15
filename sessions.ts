/**
 * Session, model and agent presentation.
 *
 * The API types are wide and WeChat is a narrow, monospaced, 3200-character
 * phone screen: everything here exists to turn OpenCode's objects into
 * something readable and back into something addressable.
 */

import type { ApiSession } from "./api.ts"

export interface ModelSummary {
  providerID: string
  id: string
  name?: string
  cost?: number
  contextLimit?: number
  enabled?: boolean
}

export interface AgentSummary {
  id: string
  name?: string
  description?: string
  mode?: string
  hidden?: boolean
}

function shorten(value: string | undefined, limit: number): string {
  if (!value) return ""
  const single = value.replace(/\s+/g, " ").trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}

/**
 * Read a value out of a plugin-context reply.
 *
 * The context is not uniform: `session.create`/`get` answer with the value
 * itself while `model.list`, `model.default` and `agent.list` answer with
 * `{ location, data }`. Both shapes are accepted here so a future change in
 * either direction cannot silently empty a list — which is exactly how `/model`
 * ended up reporting "没有可用模型".
 */
export function unwrapData<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as { data: T }).data
  }
  return value as T
}

export function unwrapList<T>(value: unknown): T[] {
  const inner = unwrapData<unknown>(value)
  if (Array.isArray(inner)) return inner as T[]
  return []
}

/** Last path segment, which is what a person recognises a project by. */
export function shortDirectory(directory?: string): string {
  if (!directory) return "?"
  const parts = directory.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? directory
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return ""
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 90) return "刚刚"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  return `${days} 天前`
}

/** Resolve a `/switch` argument against the list the user just saw. */
export function resolveSessionTarget(sessions: ApiSession[], argument: string): ApiSession | undefined {
  const value = argument.normalize("NFKC").trim()
  if (!value) return undefined

  const index = Number.parseInt(value, 10)
  if (Number.isFinite(index) && String(index) === value && index >= 1 && index <= sessions.length) {
    return sessions[index - 1]
  }

  const exact = sessions.find((session) => session.id === value)
  if (exact) return exact

  const bySuffix = sessions.find((session) => session.id.endsWith(value))
  if (bySuffix) return bySuffix

  const lowered = value.toLowerCase()
  const byTitle = sessions.filter((session) => (session.title ?? "").toLowerCase().includes(lowered))
  return byTitle.length === 1 ? byTitle[0] : undefined
}

export function describeSession(session: ApiSession, fallbackDirectory?: string): string {
  const lines = [
    "🔗 当前会话",
    `标题：${shorten(session.title, 60) || "(无标题)"}`,
    `目录：${session.location?.directory ?? fallbackDirectory ?? "?"}`,
    `编号：${session.id}`,
  ]
  if (session.agent) lines.push(`agent：${session.agent}`)
  if (session.model) lines.push(`模型：${session.model.providerID}/${session.model.id}${session.model.variant ? `#${session.model.variant}` : ""}`)
  if (typeof session.cost === "number") lines.push(`花费：$${session.cost.toFixed(4)}`)
  const updated = formatRelativeTime(session.time?.updated)
  if (updated) lines.push(`最近活动：${updated}`)
  return lines.join("\n")
}

/*
 * ---------------------------------------------------------------------------
 * Models
 * ---------------------------------------------------------------------------
 */

const MAX_MODELS_SHOWN = 40

export function formatModelList(models: ModelSummary[], current?: { providerID: string; id: string }): string {
  const usable = models.filter((model) => model.enabled !== false)
  if (usable.length === 0) return "没有可用模型。"
  const lines = usable.slice(0, MAX_MODELS_SHOWN).map((model, index) => {
    const isCurrent = current && current.providerID === model.providerID && current.id === model.id
    const marker = isCurrent ? "▶ " : "  "
    const context = model.contextLimit ? `${Math.round(model.contextLimit / 1000)}k` : ""
    const price = typeof model.cost === "number" && model.cost > 0 ? `$${model.cost.toFixed(2)}/M` : "免费"
    return `${marker}${index + 1}. ${model.providerID}/${model.id}${context ? ` · ${context}` : ""} · ${price}`
  })
  return [
    `可用模型（显示 ${lines.length}/${usable.length}）：`,
    ...lines,
    "",
    "用 /model 序号 或 /model providerID/modelID 切换。",
  ].join("\n")
}

export function resolveModelTarget(models: ModelSummary[], argument: string): ModelSummary | undefined {
  const value = argument.normalize("NFKC").trim()
  if (!value) return undefined
  // Numbering, listing and lookup share one filtered list — and the same display
  // cap — so an index nobody could have read off the list is not accepted.
  const usable = models.filter((model) => model.enabled !== false)

  const index = Number.parseInt(value, 10)
  if (Number.isFinite(index) && String(index) === value) {
    return index >= 1 && index <= MAX_MODELS_SHOWN ? usable[index - 1] : undefined
  }

  const exact = usable.find((model) => `${model.providerID}/${model.id}` === value || model.id === value)
  if (exact) return exact
  const lowered = value.toLowerCase()
  const byName = usable.filter((model) => model.id.toLowerCase().includes(lowered))
  return byName.length === 1 ? byName[0] : undefined
}

/*
 * ---------------------------------------------------------------------------
 * Agents
 * ---------------------------------------------------------------------------
 */

export function formatAgentList(agents: AgentSummary[], current?: string): string {
  const usable = agents.filter((agent) => agent.hidden !== true && agent.mode !== "subagent")
  const lines = usable.map((agent, index) => {
    const marker = agent.id === current ? "▶ " : "  "
    const description = shorten(agent.description, 50)
    return `${marker}${index + 1}. ${agent.name ?? agent.id}${description ? ` — ${description}` : ""}`
  })
  return [`可用 agent：`, ...lines, "", "用 /agent 序号 或 /agent id 切换。"].join("\n")
}

export function resolveAgentTarget(agents: AgentSummary[], argument: string): AgentSummary | undefined {
  const value = argument.normalize("NFKC").trim()
  if (!value) return undefined
  // The same filtered list backs numbering, listing and lookup: `/agent helper`
  // must not switch to an agent the list deliberately hides.
  const usable = agents.filter((agent) => agent.hidden !== true && agent.mode !== "subagent")

  const index = Number.parseInt(value, 10)
  if (Number.isFinite(index) && String(index) === value) return usable[index - 1]
  return usable.find((agent) => agent.id === value || agent.name === value)
}

/*
 * ---------------------------------------------------------------------------
 * Titles
 * ---------------------------------------------------------------------------
 */

/**
 * Title for a session created from WeChat, taken from the first message.
 *
 * The session list is the only index the user has on a phone, so "微信" for
 * every session is useless; the first instruction is the best label available
 * without spending a model call.
 */
export function titleFromText(text: string, limit = 40): string | undefined {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return undefined
  const cleaned = firstLine.replace(/[`*_>#]+/g, "").trim()
  if (!cleaned) return undefined
  return cleaned.length > limit ? cleaned.slice(0, limit) : cleaned
}
