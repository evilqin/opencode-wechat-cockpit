/**
 * Keep the test count in the docs honest.
 *
 * The READMEs and the newest CHANGELOG section state a number that users can
 * check by running the suite themselves; this script counts the actual `test(`
 * declarations and fails when any of those claims has drifted.
 *
 * Run locally with `node scripts/check-docs.mjs`; CI runs it too.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const testsDir = join(root, "tests")

let count = 0
for (const file of readdirSync(testsDir).filter((name) => name.endsWith(".test.ts"))) {
  const text = readFileSync(join(testsDir, file), "utf8")
  count += (text.match(/\btest\(/g) ?? []).length
}

const problems = []
const expectContains = (file, needle, label) => {
  const text = readFileSync(join(root, file), "utf8")
  if (!text.includes(needle)) problems.push(`${file} 缺少 ${label}：“${needle}”`)
}

expectContains("README.md", `${count} 个自动化测试`, "最新测试数")
expectContains("README.en.md", `${count} automated tests`, "latest test count")

// Only the newest CHANGELOG section has to carry the current number; older
// sections keep their own (historical) counts on purpose.
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")
const newest = changelog.split(/\n## /)[1] ?? ""
if (!newest.includes(`**${count} 个测试**`)) {
  problems.push(`CHANGELOG.md 最新版本段缺少：“**${count} 个测试**”`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  console.error(`\n请把文档里的测试数改成实际数量：${count}`)
  process.exit(1)
}

console.log(`✓ 文档测试数一致：${count} 个测试`)
