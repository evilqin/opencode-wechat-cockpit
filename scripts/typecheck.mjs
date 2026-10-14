/**
 * Strict type-check, with a readable error when the type-only dependencies in
 * `types/` were never installed.
 *
 * They live in a subdirectory on purpose (the plugin must never resolve
 * `@opencode/plugin` at runtime, only the host's copy), so `types/` is
 * gitignored and a fresh clone has to install it once:
 *
 *   cd types && bun install
 */

import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, "types", "node_modules", "typescript", "bin", "tsc")

if (!existsSync(tsc)) {
  console.error("类型检查依赖未安装。先执行：\n\n  cd types && bun install\n")
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], {
  cwd: root,
  stdio: "inherit",
})
process.exit(result.status ?? 1)
