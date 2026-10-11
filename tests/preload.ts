/**
 * Test preload.
 *
 * Runs before any test file imports the bridge modules, which matters because
 * `state.ts` and `config.ts` read their paths at module scope. Without this, a
 * bare `bun test` would use the real `~/.config/opencode/wechat` directory — and
 * a test that writes state would overwrite live credentials.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.WECHAT_STATE_DIR ??= mkdtempSync(join(tmpdir(), "wechat-test-state-"))
process.env.WECHAT_SERVICE_FILE ??= join(process.env.WECHAT_STATE_DIR, "no-such-service.json")
