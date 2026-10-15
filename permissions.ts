/**
 * Permission relay.
 *
 * A session blocked on an approval is a session the user cannot see: they read
 * the question on their phone, answer with a digit, and the desktop stops
 * waiting. Everything about the wording here is chosen for that one gesture —
 * the actions, a short list of resources, and three numbered replies.
 */

export type PermissionDecision = "once" | "always" | "reject"

export const DECISION_LABEL: Record<PermissionDecision, string> = {
  once: "允许一次",
  always: "总是允许",
  reject: "拒绝",
}

export interface PendingPermission {
  conversationId: string
  sessionID: string
  requestID: string
  action: string
  resources: string[]
  createdAt: number
  /** Whether the user has been told about this request yet. */
  announced?: boolean
}

/** Maximum simultaneous approvals held per conversation. */
export const MAX_PENDING_PERMISSIONS = 10

/**
 * Read a decision out of a bare message.
 *
 * Deliberately strict: a permission prompt is outstanding, but the user may
 * still be typing a normal instruction, and turning "1 加 1 等于几" into an
 * approval would be much worse than missing a shortcut. Only a whole message
 * that is nothing but a decision counts.
 */
export function parseDecision(text: string): PermissionDecision | undefined {
  const value = text.trim().toLowerCase().replace(/[。.!！]+$/, "")
  if (["1", "y", "yes", "ok", "allow", "once", "允许", "允许一次", "同意", "可以", "批准"].includes(value)) {
    return "once"
  }
  if (["2", "a", "always", "总是", "总是允许", "以后都允许", "一直允许"].includes(value)) return "always"
  if (["3", "n", "no", "reject", "deny", "拒绝", "不允许", "不行", "驳回"].includes(value)) return "reject"
  return undefined
}

/** `1`, `2`, `3`, or an explicit verb — used by `/allow` and `/deny` too. */
export function parseSelector(argument: string): { index?: number; all: boolean; invalid?: boolean } {
  // NFKC: a full-width digit from a Chinese IME must resolve like an ASCII one.
  const value = argument.normalize("NFKC").trim().toLowerCase()
  if (!value) return { all: false }
  if (value === "all" || value === "*" || value === "全部" || value === "所有") return { all: true }
  // Approval is security-relevant: `2x`, `3.9` or `abc` must not silently select
  // item 1 (or a truncated number) and then be acted on.
  if (!/^\d+$/.test(value)) return { all: false, invalid: true }
  const index = Number.parseInt(value, 10)
  if (!Number.isFinite(index) || index < 1) return { all: false, invalid: true }
  return { index, all: false }
}

function shorten(value: string, limit = 96): string {
  const single = value.replace(/\s+/g, " ").trim()
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single
}

/**
 * The message pushed to WeChat for one approval request.
 *
 * `position` and `total` are shown only when several are queued, so the common
 * single-approval case stays short.
 */
export function formatPermissionPrompt(
  request: PendingPermission,
  position: number,
  total: number,
  sessionTitle?: string,
): string {
  const lines = ["🔐 opencode 需要你确认"]
  if (sessionTitle) lines.push(`会话：${sessionTitle}`)
  lines.push(`操作：${request.action}`)

  const shown = request.resources.slice(0, 3).map((item) => `· ${shorten(item)}`)
  if (shown.length) lines.push("对象：", ...shown)
  if (request.resources.length > shown.length) {
    lines.push(`· …还有 ${request.resources.length - shown.length} 项`)
  }

  lines.push("", "回复数字：", "1 = 允许一次", "2 = 总是允许", "3 = 拒绝")
  if (total > 1) {
    lines.push("", `这是第 ${position}/${total} 个待审批；也可以用 /allow <序号>、/deny <序号>。`)
  }
  return lines.join("\n")
}

/**
 * A compact list used when several approvals arrive in one burst.
 *
 * `positions` are the requests' places in the *whole* pending list, not 1..N of
 * this burst: the numbers the user reads must be the numbers `/allow <n>`
 * resolves, or a "deny 2" can land on a different request than the one shown.
 */
export function formatPermissionBatch(
  requests: PendingPermission[],
  positions: number[],
  total: number,
  sessionTitle?: string,
): string {
  const lines = [
    `🔐 opencode 需要你确认（${requests.length} 项${total > requests.length ? `，共 ${total} 个待审批` : ""}）`,
  ]
  if (sessionTitle) lines.push(`会话：${sessionTitle}`)
  lines.push("")
  for (const [index, request] of requests.entries()) {
    const target = shorten(request.resources[0] ?? "", 70)
    lines.push(`${positions[index] ?? index + 1}. ${describeAction(request.action)}${target ? ` — ${target}` : ""}`)
  }
  lines.push("", "回复：/allow 序号 或 /deny 序号；/allow all 一次全允许。")
  return lines.join("\n")
}

/** A compact list used when the bridge decides to resend queued approvals. */
export function formatPendingSummary(pending: PendingPermission[]): string {
  return [
    `还有 ${pending.length} 个待审批：`,
    ...pending.map((item, index) => `${index + 1}. ${describeAction(item.action)} — ${shorten(item.resources[0] ?? "", 60)}`),
    "",
    "用 /allow <序号> 或 /deny <序号> 处理。",
  ].join("\n")
}

/** OpenAI-style action names are fine, but a couple deserve a translation. */
export function describeAction(action: string): string {
  const table: Record<string, string> = {
    bash: "执行命令",
    edit: "修改文件",
    write: "写入文件",
    read: "读取文件",
    webfetch: "访问网络",
    websearch: "联网搜索",
    external_directory: "访问项目外目录",
  }
  return table[action] ?? action
}
