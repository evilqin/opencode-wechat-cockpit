/**
 * Render MANUAL.md from the same data `/help` answers with.
 *
 *   bun gen-manual.ts
 *
 * Keeping the file generated (instead of hand-written) means the manual that
 * sits in the plugin folder can never disagree with the bot.
 */

import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { COMMAND_DOCS, HELP_TEXT } from "./manual.ts"

const here = dirname(fileURLToPath(import.meta.url))

const sections = COMMAND_DOCS.map((doc) => {
  const lines = [
    `### ${doc.name}`,
    "",
    doc.summary,
    "",
    `\`\`\`text`,
    `用法：${doc.usage}`,
    ...(doc.aliases.length > 0 ? [`别名：${doc.aliases.join(" ")}`] : []),
    `\`\`\``,
  ]
  if (doc.examples?.length) lines.push("例子：", "", ...doc.examples.map((example) => `- \`${example}\``), "")
  if (doc.notes?.length) lines.push("注意：", "", ...doc.notes.map((note) => `- ${note}`), "")
  return lines.join("\n")
})

const manual = [
  "# opencode 微信命令手册",
  "",
  "> 由 `gen-manual.ts` 从 `manual.ts` 生成 —— 想改手册，改 `manual.ts` 再跑 `bun gen-manual.ts`。",
  "> 微信里随时可以发 `/help` 看总览、`/help 命令` 看单条、`/help 全部` 让机器人重发这份全文。",
  "",
  "## 总览（= 微信里发的 `/help`）",
  "",
  "```text",
  HELP_TEXT,
  "```",
  "",
  "## 逐条详解",
  "",
  ...sections,
].join("\n")

writeFileSync(join(here, "MANUAL.md"), `${manual.trimEnd()}\n`)
console.log(`MANUAL.md: ${COMMAND_DOCS.length} commands, ${manual.length} chars`)
