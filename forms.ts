/**
 * Interactive questions ("forms") relayed to WeChat.
 *
 * The agent can raise a form mid-turn — a multiple choice, a confirmation, a
 * short text — and then it blocks. Relaying that to the phone is the difference
 * between "the answer arrives while you are out" and "the task hangs until you
 * get back to the desk".
 *
 * Answers are submitted through the local HTTP API, because the plugin context
 * exposes no form domain.
 */

import type { ApiFormField } from "./api.ts"

export interface PendingForm {
  conversationId: string
  sessionID: string
  formID: string
  title: string
  fields: ApiFormField[]
  createdAt: number
}

/** WeChat shows a wall of text badly; cap how many questions are printed. */
const MAX_FIELDS_SHOWN = 8
const MAX_OPTIONS_SHOWN = 10

function shorten(value: string, limit = 120): string {
  const single = value.replace(/\s+/g, " ").trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}

/** The prompt pushed to WeChat when a form appears. */
export function formatFormPrompt(form: PendingForm, queuePosition: number, queueLength: number): string {
  const lines = [`❓ opencode 想问你${form.title ? `：${shorten(form.title, 60)}` : ""}`]
  if (queueLength > 1) lines.push(`（第 ${queuePosition}/${queueLength} 个待回答）`)

  const shown = form.fields.slice(0, MAX_FIELDS_SHOWN)
  for (const [index, field] of shown.entries()) {
    const kind =
      field.type === "boolean"
        ? "是/否"
        : (field.options?.length ?? 0) > 0
          ? "选择题"
          : (field.type ?? "string")
    lines.push("", `${index + 1}. ${field.title ?? field.key ?? "问题"}${field.required ? "（必填）" : ""} [${kind}]`)
    if (field.description) lines.push(`   ${shorten(field.description)}`)
    for (const option of (field.options ?? []).slice(0, MAX_OPTIONS_SHOWN)) {
      const detail = option.description ? ` — ${shorten(option.description, 50)}` : ""
      lines.push(`   · ${shorten(option.label ?? option.value, 60)}${detail}`)
    }
  }
  if (form.fields.length > shown.length) lines.push(`…还有 ${form.fields.length - shown.length} 个问题未显示`)

  const multi = shown.length > 1
  lines.push(
    "",
    multi
      ? "回复：/answer 1=答案; 2=答案   （数字是上面的问题号）"
      : "回复：/answer 答案",
    "选择题可以直接回选项序号，例如 /answer 2；多选题用逗号分隔，例如 /answer 1,3。",
  )
  return lines.join("\n")
}

export interface ResolvedAnswer {
  answer: Record<string, unknown>
  /** Human-readable echo of what was submitted. */
  summary: string
}

/**
 * Turn `/answer ...` text into the API payload.
 *
 * Supported shapes:
 *   `/answer 2`                 — single field, pick option 2 (or literal `2`)
 *   `/answer pnpm,kimi`         — multiselect by option number or label
 *   `/answer 1=pnpm; 2=yes`     — several fields by question number
 *   `/answer 1：pnpm；2：是`      — the same with full-width punctuation, which is
 *                                 what a Chinese keyboard produces by default
 */
export function resolveAnswer(form: PendingForm, input: string): ResolvedAnswer | { error: string } {
  const fields = form.fields
  if (fields.length === 0) return { error: "这个表单没有可回答的问题" }

  const trimmed = input.trim()
  if (!trimmed) return { error: "没有内容。用法：/answer <答案>" }

  // Field-by-field form: `1=value; 2=value`, with either width of separator.
  const pairs = trimmed
    .split(/[;\n；]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(\d+)\s*[=:：]\s*(.*)$/)
      return match ? { index: Number.parseInt(match[1], 10) - 1, value: match[2] } : undefined
    })

  if (pairs.length > 0 && pairs.every((entry) => entry !== undefined)) {
    const answer: Record<string, unknown> = {}
    const summary: string[] = []
    for (const pair of pairs) {
      if (!pair) continue
      const field = fields[pair.index]
      if (!field) return { error: `没有第 ${pair.index + 1} 个问题` }
      const converted = convertValue(field, pair.value)
      if (typeof converted === "string" && converted.startsWith("!")) return { error: converted.slice(1) }
      answer[field.key] = converted
      summary.push(`${pair.index + 1}. ${describeValue(field, converted)}`)
    }
    const missing = missingRequired(fields, answer)
    if (missing.length > 0) return { error: `还没回答：${missing.join("、")}` }
    return { answer, summary: summary.join("；") }
  }

  // Single-value answer: only unambiguous when there is exactly one question.
  if (fields.length > 1) {
    return { error: "这个表单有多个问题，请用 /answer 1=答案; 2=答案 的形式" }
  }

  const field = fields[0]
  const converted = convertValue(field, trimmed)
  if (typeof converted === "string" && converted.startsWith("!")) return { error: converted.slice(1) }
  return { answer: { [field.key]: converted }, summary: describeValue(field, converted) }
}

/** Questions that must be answered but were not. */
export function missingRequired(fields: ApiFormField[], answer: Record<string, unknown>): string[] {
  return fields
    .filter((field) => field.required === true && field.type !== "external")
    .filter((field) => {
      const value = answer[field.key]
      if (value === undefined || value === null) return true
      if (typeof value === "string") return value.trim() === ""
      if (Array.isArray(value)) return value.length === 0
      return false
    })
    .map((field) => field.title ?? field.key ?? "问题")
}

function describeValue(field: ApiFormField, value: unknown): string {
  const options = field.options ?? []
  const option = options.find((entry) => entry.value === value)
  const shown =
    typeof value === "boolean"
      ? value
        ? "是"
        : "否"
      : (option?.label ?? (Array.isArray(value) ? value.join(", ") : String(value)))
  return `${field.title ?? field.key ?? "问题"}=${shown}`
}

/**
 * Coerce one answer for its field.
 *
 * Errors are returned as strings prefixed with `!` so the caller can tell a
 * validation failure from a legitimate answer that happens to be a string.
 */
function convertValue(field: ApiFormField, raw: string): unknown {
  const value = raw.trim()
  const options = field.options ?? []
  const fromOption = (input: string): string | undefined => {
    // Only a bare integer is an option index. `parseInt` would happily read the
    // leading digits of "2；2=是" and silently answer a different question.
    if (/^\d+$/.test(input)) {
      const index = Number.parseInt(input, 10)
      if (index >= 1 && index <= options.length) return options[index - 1].value
      return undefined
    }
    const byLabel = options.find((option) => option.label === input || option.value === input)
    return byLabel?.value
  }

  switch (field.type) {
    case "boolean": {
      const lowered = value.toLowerCase()
      if (["y", "yes", "true", "1", "是", "好", "同意", "允许"].includes(lowered)) return true
      if (["n", "no", "false", "0", "否", "不", "拒绝"].includes(lowered)) return false
      return `!无法理解为是/否：${value}`
    }
    case "integer": {
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed)) return `!需要整数：${value}`
      return parsed
    }
    case "number": {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return `!需要数字：${value}`
      return parsed
    }
    case "multiselect": {
      const parts = value
        .split(/[,，、\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
      const values: string[] = []
      for (const part of parts) {
        const resolved = fromOption(part) ?? part
        if (options.length > 0 && !options.some((option) => option.value === resolved)) {
          return `!选项不存在：${part}`
        }
        values.push(resolved)
      }
      if (values.length === 0) return "!没有选择任何选项"
      return values
    }
    case "external":
      return `!这个问题要在桌面端处理（外部表单）`
    default: {
      if (options.length > 0) {
        const resolved = fromOption(value)
        if (resolved === undefined && field.custom !== true) {
          return `!请回复选项号或选项文字（1-${options.length}）`
        }
        return resolved ?? value
      }
      if (field.required && !value) return `!这个问题必填`
      return value
    }
  }
}

/** A one-line acknowledgement of what was submitted. */
export function describeAnswer(form: PendingForm, summary: string): string {
  return `✅ 已提交回答${form.title ? `（${form.title}）` : ""}：${summary}`
}
