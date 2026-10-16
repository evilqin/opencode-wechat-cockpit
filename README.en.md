# opencode-wechat-cockpit

[![CI](https://github.com/evilqin/opencode-wechat-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/evilqin/opencode-wechat-cockpit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[中文](README.md) | **English**

Drive [opencode](https://opencode.ai) on this computer from WeChat.

Send a message (or an image, file, video) from your phone; opencode does the work on the
computer; the result comes back to WeChat. Because the plugin runs **inside** the opencode
server process, it keeps working while the desktop is locked or the terminal is closed.

No public IP, no port forwarding, no extra runtime: your phone talks to Tencent's iLink
gateway and this machine's opencode **long-polls outbound**, so all you need is the computer
turned on with opencode running.

```
WeChat (phone) ──► Tencent iLink gateway ──► local opencode server
                                              └── this plugin
                                                  ├─ sessions: WeChat DM ↔ opencode session
                                                  ├─ attachments both ways: image / file / video
                                                  ├─ approvals & questions: reply 1/2/3 or /answer
                                                  ├─ control: /new /list /switch /model /agent /cost
                                                  └─ push: wechat_send / wechat_send_file
```

## What makes it different

Most bridges do one thing: forward your message to an AI and send the answer back. This one
is built for "**you are away, the computer is working**":

| | |
| --- | --- |
| 🛂 **Approvals reach your phone** | When the agent wants to run a command or edit a file, WeChat gets a confirmation card — reply `1`/`2`/`3` and the turn continues. **Nothing gets stuck while you are away**; this is the main reason the plugin exists. |
| ❓ **Questions too** | The agent's interactive forms (choice / free text) are delivered to WeChat and answered with `/answer`; the `wechat_ask` tool lets the agent ask you a question and **block on your answer**. |
| 🏠 **The phone has a home session** | Messages default to the phone's own home session; `/attach` **borrows** any desktop session (including one that is currently running), `/detach` hands it back. It is the same session on both sides, not a mirror. |
| 🔒 **Single poller + self-healing** | One poller per machine no matter how many project windows are open; the lock records when the poll loop last moved, so an owner that goes silent is taken over within 2 minutes; a watchdog rebuilds a stalled connection. |
| 📬 **Messages are not lost** | Refused sends are queued and retried with backoff, then flushed the moment you speak; the queue survives plugin hot-reloads; the long-poll cursor is persisted before dispatch, so a crash replays instead of dropping. |
| 🔁 **Half an answer is still recoverable** | Multi-part replies are numbered `（1/3）…`; rate-limited parts are queued and re-sent automatically; `/more` (`/继续`) tells the two cases apart — **stuck text is re-sent without calling the model, only a genuinely unfinished answer asks it to continue** |
| 🔁 **Duplicates cost nothing** | `message_id` dedup (last 200) so a redelivered message never triggers a second model call. |
| 📚 **Manual on your phone** | `/help` for the overview, `/help attach` for one command, `/help 全部` for the full manual; `MANUAL.md` is generated from the same source as the bot's answers; `/list` supports paging. |
| 🧪 **Tested** | 206 automated tests (unit + mock-iLink protocol + fake-context behaviour) with strict type checking (including `noUnusedLocals`). Real-device verification is at the bottom. |

## Quickstart

```bash
# 1) clone into opencode's plugin directory (it is discovered automatically)
git clone https://github.com/evilqin/opencode-wechat-cockpit.git ~/.config/opencode/plugins/wechat
# 2) the QR login needs two dependencies (installed in the config directory)
cd ~/.config/opencode && bun add qrcode qrcode-terminal
# 3) type /wechat-login in an opencode session, scan with WeChat, then message the bot
```

## Files

| File | Role |
| --- | --- |
| `index.ts` | plugin entry: `Plugin.define`, ownership tick, agent tools, server commands |
| `ilink.ts` | iLink protocol: login, long poll, send, typing, media upload |
| `monitor.ts` | inbound loop: cursor persisted first, backoff, self-exit on lost lock |
| `bridge.ts` | orchestration: commands, replies, approvals, questions, media, queue |
| `media.ts` | attachments: download+decrypt / encrypt+upload |
| `api.ts` | client for the local opencode HTTP API (session list, form replies) |
| `permissions.ts` / `forms.ts` | approval & question presentation and answer parsing |
| `sessions.ts` | session/model/agent presentation and resolution |
| `state.ts` | on-disk state and the single-poller lock |
| `config.ts` | settings read/write |
| `manual.ts` | single source of truth for the command manual (`/help` and `MANUAL.md`) |
| `gen-manual.ts` | renders `MANUAL.md` (`bun gen-manual.ts`) |
| `login-cli.ts` / `verify.ts` | terminal QR login / health check |
| `tests/` | unit tests + integration tests against a mock iLink server |

## Install

Requirements: **opencode 2.x** (uses the v2 `@opencode/plugin` API), **Bun ≥ 1.0**.
Windows / macOS / Linux all work (Windows is the primary, real-device-tested platform).

1. Clone into opencode's plugin directory (it is discovered automatically; saving a file hot-reloads it):

   ```bash
   git clone https://github.com/evilqin/opencode-wechat-cockpit.git ~/.config/opencode/plugins/wechat
   ```

2. The QR login needs two dependencies, installed in the config directory
   (the plugin itself always uses the host's copies):

   ```bash
   cd ~/.config/opencode
   bun add qrcode qrcode-terminal
   ```

3. Health check:

   ```bash
   bun ~/.config/opencode/plugins/wechat/verify.ts
   ```

## Login

```bash
bun ~/.config/opencode/plugins/wechat/login-cli.ts
```

Scan the QR code and confirm on the phone. Credentials go to
`~/.config/opencode/wechat/state.json` (0600 on POSIX; on Windows the file inherits the profile ACL).

Or stay in the GUI: type `/wechat-login` in an opencode session and the QR code is posted
into that session.

```bash
bun ...login-cli.ts --status   # binding, directory, session count
bun ...login-cli.ts --logout   # wipe local credentials (keeps the old token so a re-scan rebinds the same bot)
bun ...login-cli.ts --purge    # forget the old token too (a new scan creates a fresh binding)
bun ...login-cli.ts --force    # re-scan even when already logged in
```

## Usage

### Basics

| What | How |
| --- | --- |
| Talk to the agent | send any text |
| Send a file | send an image / file / video — it is downloaded, decrypted and handed to the model as a local path; the reply mentions the stored file |
| Interrupt | `/cancel` (interrupts the running turn), `/cancel all` also drops queued messages |
| Unknown | `/help` |

### Sessions

| Command | What it does |
| --- | --- |
| `/new [标题或目录]` | new session; an existing directory becomes its working directory |
| `/list [all] [页码]` | the phone's sessions (📌 = home); `all` = everything else, paging is in the footer |
| `/attach [序号\|id]` | follow the session the desktop is working in; with an argument, borrow that one |
| `/channel [序号\|id]` | view / move the "home" session (where `/detach` returns to) |
| `/switch 序号\|短号\|标题` | switch sessions (manual choice is respected by auto-follow for 5 min) |
| `/last` | back to the previous session |
| `/current` | details of the active session (directory, model, cost, last activity) |
| `/rename 标题` | rename the active session |
| `/dir [路径]` | view / set the default working directory for new sessions |
| `/queue [clear]` | see queued (undeliverable) messages / drop them |
| `/cost` | cost and token usage of the active session |

### Models & agents

| Command | What it does |
| --- | --- |
| `/model` | list available models (context size and price) |
| `/model 序号` / `/model providerID/modelID` | switch model |
| `/agent` / `/agent 序号` | list / switch agent |

### Interaction

| Situation | What to do |
| --- | --- |
| agent asks to run something | WeChat shows a "🔐 需要你确认" card; reply `1` = allow once, `2` = always, `3` = deny |
| several pending approvals | `/allow 序号`, `/always 序号`, `/deny 序号`, `/deny all` |
| agent asks a question (form) | WeChat shows "❓ …"; answer with `/answer …` (multi-field: `/answer 1=…; 2=…`) |

Approvals and questions **wait for you**: the turn stays blocked until you answer, so leaving
the computer does not stall it.

### Misc

`/status` connection · `/more` (`/继续`) fetch a stuck tail, or make the model continue writing · `/retry` flush the queue now · `/ping` · `/whoami` ·
`/log [行数]` · `/help [命令|全部]`

### Desktop commands (typed in opencode)

| Command | What it does |
| --- | --- |
| `/wechat-login` | QR login (code posted into the session) |
| `/wechat-attach` | lend the current session to the phone |
| `/wechat-detach` | take it back |
| `/wechat-status` | connection status |
| `/wechat-config` | view / edit settings |

## Tools the agent can use

| Tool | Purpose |
| --- | --- |
| `wechat_send` | send text (optionally with a `file`) |
| `wechat_send_file` | send an image / video / file (images render natively) |
| `wechat_ask` | **ask you a question in WeChat and wait for the answer** (10 min default) |
| `wechat_status` | channel status |

So "tell me when it's done", "send me the result", "ask me before publishing" all work.
`wechat_ask` is the escape hatch for human decisions: the question lands on your phone and
whatever you reply becomes the tool's return value.

## Settings

`~/.config/opencode/wechat/config.json` (also editable with `/wechat-config`, applied within 10 s):

```jsonc
{
  "directory": "C:\\Users\\you",   // default working directory for new sessions
  "progress": "tools",             // tools = one line per tool call; off = final answer only
  "stream": "off",                 // live = push text while it is still being written
  "streamIntervalMs": 8000,        // live push interval
  "turnGraceMs": 3000,             // how long a finished text block waits when no end signal arrives
  "turnSettleMs": 600,             // settle window after the real end signal (session.status idle)
  "mirrorAll": false,              // also push results of sessions that are not bound to WeChat
  "followActive": false,           // auto-follow the session the desktop is working in
  "followHoldMs": 300000,          // manual switch wins for this long
  "followWindowMs": 600000,        // only follow sessions active within this window
  "autoTitle": true,               // name a session after its first message
  "ack": "off",                    // text = send "收到，开始处理…" immediately
  "sendDelayMs": 250,              // delay between chunks (bursts get refused more often)
  "chunkSize": 3900,               // long answers are split (service limit 4000); parts are numbered （1/3）
  "listLimit": 15,                 // rows per page of /list
  "allowedUsers": [],              // WeChat id allowlist; empty = the bound account only
  "agent": "",                     // pin an agent for new sessions
  "model": "",                     // pin a model for new sessions (providerID/modelID)
  "askTimeoutMs": 600000,          // wechat_ask timeout
  "approvalBurstMs": 800,          // batch a burst of approvals into one message
  "retryBackoffMs": [5000, 15000, 45000, 120000, 300000]
}
```

Environment variables (all optional):

| Variable | Purpose |
| --- | --- |
| `WECHAT_STATE_DIR` | move the state directory (default `~/.config/opencode/wechat`) |
| `WECHAT_SERVICE_FILE` | explicit opencode service registration file |
| `WECHAT_QR_PNG` | output path for the login QR PNG |

## How it works

**Single poller.** The plugin loads once per open location and they share one process. The
lock is claimed with an **exclusive create** (`wx`); losers re-check every 10 s, the winner
long-polls and re-verifies ownership every cycle. Apart from a heartbeat, the lock stores when the
**poll loop last moved** (`polledAt`, including empty client-side timeouts) and when the **server
last actually answered** (`answeredAt`): a heartbeat only proves the instance is alive, not that it
is still receiving. A standby that sees `polledAt` frozen for 2 minutes takes over —
that is how "the channel suddenly went deaf with nobody polling" heals itself (seen three
times on real hardware).

**Dedup.** Inbound `message_id`s are kept in the state file (last 200); redelivery is ignored,
because a duplicate costs a real model call.

**Reply window.** The server ties a bot's replies to *your* last message. Once the window is
closed, sends fail with `errcode=-2 errmsg=prepare failed`. The plugin queues the text,
retries with 5s → 15s → 45s → 2min → 5min backoff, and **flushes the queue the moment you
send anything**. Media (files/images) are stricter than text.

**Replies, but not forever.** WeChat cannot edit messages, so text is assembled per turn and
sent when the turn ends. The reliable signals are `session.status` (`status.type: "idle"`) and
`session.execution.succeeded`; after one of them the reply waits only `turnSettleMs` (0.6 s) so a
trailing text block can still merge. A **step boundary** (`session.step.ended`) is used as an
accelerator with the same short window — and is undone the moment a tool call or a new block
shows the turn is still going, so multi-step answers are not split. If no signal arrives at all,
`turnGraceMs` (3 s) is the fallback. `reply sent (trigger: idle|step|timer)` says which path ran.

**Cursor before dispatch.** The long-poll cursor is written to disk before messages are
handled: a crash replays, it does not drop.

**Local API.** The plugin context has no session list and no form replies, so the plugin reads
the address and password from `~/.local/state/opencode/service.json` and calls the local
opencode HTTP API with HTTP Basic.

## Coexistence with other plugins

Multiple opencode plugins on one machine are normal; this plugin takes care not to get in their way:

- **Single-poller lock**: no matter how many project windows are open (each loads a plugin instance), exactly one instance polls WeChat at a time, and the slot is taken over within 2 minutes if the holder wedges.
- **A human wait is never mistaken for a stall**: while `wechat_ask` waits for an answer it reports tool progress (`session.tool.progress`) every 60 seconds, so stall-recovery plugins ("quiet for 3 minutes → inject continue") leave the wait alone.
- **`/cancel` stays cancelled**: after you stop a turn, auto-resume-style plugins do not continue it until you speak again.
- **No stealing other tools**: the `🔧` progress line only announces real work; other plugins' bookkeeping tools (e.g. `task_complete`) never show up in the chat.
- **Separate state**: the plugin only writes `~/.config/opencode/wechat/` (plus reading opencode's own `service.json`); storage, logs, commands and tool names do not overlap with other plugins.

Verified side by side with: oh-my-opencode-slim, @tarquinen/opencode-dcp, opencode-i18n-v2, auto-resume-v2 (local). If you hit a new conflict, `event type seen for the first time` lines in `bridge.log` usually point at it.

## Troubleshooting

```bash
bun ~/.config/opencode/plugins/wechat/verify.ts
```

It checks dependencies, login, directories, the lock, the local API and recent warnings.
Logs: `~/.config/opencode/wechat/bridge.log`; `/status` and `/log` work from WeChat too.

| Symptom | Cause / fix |
| --- | --- |
| no reaction to messages | no `poller started` in the log: log in first. Fresh heartbeat but stale `polledAt`: taken over within 2 minutes |
| answer did not come back | look for `send refused`; `-2 prepare failed` = window closed (auto-flushed later), `-14` = token expired |
| the answer stops halfway | multi-part replies are numbered `（1/3）（2/3）…`; a missing number means it was rate-limited — send `/more` to fetch the rest (with something stuck it **only re-sends, without calling the model**); send `/more` again to make the model continue writing |
| computer answered, phone lags | the normal path is "end signal + `turnSettleMs` (0.6 s)"; the 3 s `turnGraceMs` only applies when no signal arrives. Check `reply sent (trigger: …)` |
| grey box instead of an image | `aes_key` encoding was wrong (must be base64 of hex text) — fixed here; open an issue if you see it |
| `/list` misses desktop sessions | the local API is unavailable (`verify.ts` says so); only WeChat-created sessions are listed |
| same message handled twice | should not happen: `message_id` dedup + single poller |
| laptop asleep / offline | reconnects on wake; the cursor was persisted, nothing is lost |

> **Touching a support module? Touch the entry point.** opencode hot-reloads on the plugin
> entry, so edits to `bridge.ts`, `state.ts`, … may keep the old code running — save
> `index.ts` once (or restart the service).

## Development

```bash
cd types && bun install  # one-time: the official types (types/ is gitignored)
bun test          # 206 tests: unit + mock iLink + fake-context Bridge behaviour
bun run typecheck # strict check against the official @opencode/plugin types
bun verify.ts     # environment self-check
bun gen-manual.ts # regenerate MANUAL.md after editing manual.ts
```

| Test file | Coverage |
| --- | --- |
| `tests/unit.test.ts` | pure logic: chunking, escaping, key decoding, approval/form parsing, session parsing, config guards, lock takeover, `unwrap` shapes |
| `tests/integration.test.ts` | protocol against a mock iLink: login handshake, long poll, cursor persistence, wire shapes, media upload encryption, refusals, local API auth and 204/500 |
| `tests/bridge.test.ts` | **Bridge behaviour**: fake context + mock iLink + mock API driving `/switch` `/rename` `/model` `/cancel` `/answer` `/queue` `/last`, approval batching, streaming, the reply window, `wechat_ask`, reconnect healing, lock takeover, `mirrorAll` |

Type checking uses the official packages installed under `types/` (see `types/package.json`).
That subdirectory is deliberate: at runtime the plugin must use the host's own
`@opencode/plugin`, and `types/` is not on the module resolution path.

`bunfig.toml`'s `tests/preload.ts` points the state directory at a temp dir, so a bare
`bun test` never touches your real credentials.

### Two traps when changing code

**1. Trust the generated client types, not the docs.** The docs show
`ctx.permission.reply` taking `reply: "once"`, while the generated types say `decision` —
the wrong field name does not error, the call just silently does nothing (this bug really
happened: approvals stayed pending). To check a field name:

```bash
grep -n "PermissionReplyInput" ~/.config/opencode/node_modules/@opencode/client/dist/promise/generated/types.d.ts -A 12
```

**2. Touch the entry point after editing support modules** (see the note above).

## Verification status

Paths verified against the real Tencent service:

| Direction | Path | Evidence |
| --- | --- | --- |
| text in | long poll → session | log `inbound` + user message in the session |
| image in | CDN download → AES decrypt → file → model | real JPEG (`ffd8ffe0…`) header + the model described the screenshot correctly |
| file/video in | same path | same code path, covered by integration tests |
| answers out | agent answer → WeChat | log `sent N chars`, user replied and continued |
| push text | `wechat_send` | delivered |
| push image | encrypt → CDN upload → native image | log `sent image …`, delivered |
| push file | same (file card) | log `sent file …`, delivered |
| ask & wait | `wechat_ask` → answer → tool result | the answer text became the tool's return value |
| approvals | push → reply `1` → applied | pending count 1 → 0, "✅ 已回复" received |
| forms | push → `/answer` → submitted | server state flipped to `answered`, answer matched |
| commands | `/status` `/list` `/model` (40/73) `/agent` `/cost` `/switch` `/answer` | each has a matching `sent` record |

Not yet exercised on real hardware (covered by tests): paging (`/list 2`, `/list all 2`),
`/channel <n>`, `/help <command>` / `/help 全部`, borrowing a CLI session with `/attach <n>`,
`/cancel`, `/rename`, `/dir`, `/retry`, `/more`, `/log`, `/ping`, `/whoami`.

## Security

- **Unofficial project**, not affiliated with Tencent, WeChat or opencode. It speaks the
  WeChat ClawBot iLink bot protocol and is meant for your own account.
- It only talks to Tencent's official iLink gateway (`ilinkai.weixin.qq.com` and the IDC hosts
  it returns); there is no third-party relay.
- After the QR scan, the bot is cryptographically bound to your WeChat account: the server only
  delivers that account's messages, the bot is not a contact, cannot be searched, cannot be
  added. `allowedUsers` adds another layer.
- Credentials live only on this machine (0600 on POSIX, the profile ACL on Windows, under
  `~/.config/opencode/wechat/`, **never in
  this repo**).
- **The agent runs as you.** Sessions coming from WeChat inherit your permission settings;
  anything that needs approval is forwarded to WeChat. Loosen your agent's permissions for
  smoother work, keep approvals on for safety.

## Limitations

- Direct messages only; group messages are ignored (the ClawBot protocol only declares DMs) — a
  message carrying `group_id` is dropped before anything else happens.
- Outbound: text, image, video, file. **Sending voice is not implemented.** Inbound voice prefers
  WeChat's transcription; without one the `.silk` file is saved to the inbox and the note says the
  bridge does not transcribe it (add your own ASR if you need text).
- **A retried send is not delivered twice**: every queued message carries a stable `client_id` (reused for
  retries, the context-token fallback and plugin reloads) and the service dedupes on it.
- Agent forms go through the local API, so in `--standalone` mode with a registration pointing
  at another process, questions have to be answered on the computer.
- The opencode v2 plugin API is beta; interface changes will need a follow-up.
- WeChat-created sessions live in the **default directory** (`~` by default), so they appear
  under that project; `/dir D:\code\repo` then `/new` puts them elsewhere.
- Received attachments live in `~/.config/opencode/wechat/inbox` and are pruned after **14 days
  or 512 MB**, whichever comes first.
