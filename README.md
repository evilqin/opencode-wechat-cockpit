# opencode-wechat-cockpit · 微信驾驶舱

[![CI](https://github.com/evilqin/opencode-wechat-cockpit/actions/workflows/ci.yml/badge.svg)](https://github.com/evilqin/opencode-wechat-cockpit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**中文** | [English](README.en.md)

用微信遥控这台电脑上的 opencode：手机上发消息、发图，opencode 干活，结果回到微信。

不需要公网 IP、不需要内网穿透、不需要装 OpenClaw。手机和腾讯服务器通信，这台电脑上的
opencode **主动向外长轮询**腾讯 iLink 网关，所以电脑开着、opencode 在跑就行。

```
手机微信 ──► 腾讯 iLink 网关 ──► 本机 opencode 服务进程
                                    └── 本插件
                                        ├─ 会话：微信私聊 ↔ opencode 会话
                                        ├─ 双向附件：图片 / 文件 / 视频
                                        ├─ 审批与提问：回数字或 /answer 即可
                                        ├─ 控制：/new /list /switch /model /agent /cost
                                        └─ 主动推送：wechat_send / wechat_send_file
```

## 它不一样在哪

普通桥只做一件事：把话转给 AI，把回答发回来。这个是按「**人在外面，电脑在干活**」设计的：

| 不一样的地方 | 具体表现 |
| --- | --- |
| 🛂 **审批能到手机** | agent 要执行命令、改文件 → 微信收到确认卡片 → 回 `1`/`2`/`3` → 电脑继续跑。**你不在电脑前也不会卡住**，这是它存在的首要理由 |
| ❓ **提问也能到手机** | agent 的选择题 / 填空题同样发到微信，`/answer` 回答后继续；`wechat_ask` 让 agent 主动提问并**阻塞等待**你的答案 |
| 🏠 **手机会话有「家」** | 手机默认待在自己的主会话；`/attach` 临时**借用**电脑上任何会话（包括正在跑的那个），`/detach` 归还，两边永远是同一条会话 |
| 🔒 **单轮询器 + 自愈** | 多个项目窗口只跑一个轮询器；锁里记录「最后完成长轮询的时间」，持有者卡死 2 分钟内被接管；看门狗自动重建卡死的连接 |
| 📬 **消息不会丢** | 微信拒收 → 入队 + 退避重试 → 你下次说话立刻补发；插件热重载不丢队列；游标先落盘，崩溃是重放不是丢消息 |
| 🔁 **半截回答也能收全** | 多段回答自带编号 `（1/3）…`，被限流时入队并自动补发；`/more`（`/继续`）区分两种情况：**有卡住的就补发（不叫模型），确实没写完才让模型接着写** |
| 🔁 **重复消息不花钱** | `message_id` 去重（最近 200 条），重复投递直接忽略，不会重复调用模型 |
| 📚 **手机上就能查手册** | `/help` 总览、`/help 命令` 单条、`/help 全部` 全文；`MANUAL.md` 与代码同源自动生成；`/list` 支持翻页 |
| 🧪 **有测试套件** | 205 个自动化测试（单元 + mock iLink 协议 + 假 ctx 行为测试）+ strict 类型检查（含 `noUnusedLocals`），真机验证记录见文末 |


## 最快上手

```bash
# 1) 放进 opencode 的插件目录（会自动发现）
git clone https://github.com/evilqin/opencode-wechat-cockpit.git ~/.config/opencode/plugins/wechat
# 2) 登录二维码需要两个依赖（装在配置目录）
cd ~/.config/opencode && bun add qrcode qrcode-terminal
# 3) 在 opencode 会话里输入 /wechat-login，用微信扫码，然后在微信里发消息
```

## 文件构成

| 文件 | 作用 |
| --- | --- |
| `index.ts` | 插件入口：`Plugin.define`、所有权自检、工具、TUI 命令 |
| `ilink.ts` | iLink 协议：登录、长轮询、发送、typing、媒体上传 |
| `monitor.ts` | 收消息循环：游标先落盘、退避重试、失去锁自退 |
| `bridge.ts` | 编排：命令、回复回流、审批、提问、媒体、流式 |
| `media.ts` | 附件收发：下载解密 / 加密上传 |
| `api.ts` | 本地 opencode HTTP API 客户端（会话列表、表单回复） |
| `permissions.ts` | 审批文案与数字解析 |
| `forms.ts` | agent 提问的展示与答案解析 |
| `sessions.ts` | 会话/模型/agent 的展示与解析 |
| `state.ts` | 状态与单实例锁 |
| `config.ts` | 设置读写 |
| `manual.ts` | 命令手册的唯一来源：`/help` 三层与 `MANUAL.md` 都由它生成 |
| `gen-manual.ts` | 用 `manual.ts` 渲染 `MANUAL.md`（`bun gen-manual.ts`） |
| `login-cli.ts` | 终端扫码登录 |
| `verify.ts` | 自检：配置、依赖、登录、锁、本地 API、日志 |
| `tests/` | 单元测试 + 针对 mock iLink 服务端的集成测试 |

## 安装

需要的环境：**opencode 2.x**（本插件用 v2 的 `@opencode/plugin` API）、**Bun ≥ 1.0**、
Windows / macOS / Linux 都可以（Windows 是主力开发和真机验证平台）。

1. 克隆到 opencode 的插件目录（opencode 会自动发现，改文件即热重载）：

   ```powershell
   git clone https://github.com/evilqin/opencode-wechat-cockpit.git $env:USERPROFILE\.config\opencode\plugins\wechat
   ```

2. 渲染登录二维码需要两个依赖（装在配置目录，插件运行时用的是宿主注入的那份）：

   ```powershell
   cd $env:USERPROFILE\.config\opencode
   bun add qrcode qrcode-terminal
   ```

3. 自检：

   ```powershell
   bun $env:USERPROFILE\.config\opencode\plugins\wechat\verify.ts
   ```

## 登录

```powershell
bun $env:USERPROFILE\.config\opencode\plugins\wechat\login-cli.ts
```

扫码并在手机上确认。凭据存在 `~/.config/opencode/wechat/state.json`（POSIX 上 0600；Windows 上由用户目录 ACL 保护）。

也可以不动终端：在 opencode 会话里输入 `/wechat-login`，二维码会作为消息出现在会话里。

```powershell
bun ...login-cli.ts --status   # 看绑定、目录、会话数
bun ...login-cli.ts --logout   # 清除本地凭据（保留旧 token 以便重新绑定同一个 bot）
bun ...login-cli.ts --purge    # 连旧 token 一起清掉（下次扫码会创建新绑定）
bun ...login-cli.ts --force    # 已登录时强制重新扫码
```

## 用法

### 基本

| 你发的 | 效果 |
| --- | --- |
| 直接发消息 | 交给当前绑定的 opencode 会话 |
| 发图片 / 文件 / 视频 | 下载解密落到 `~/.config/opencode/wechat/inbox/`，路径交给 agent |
| 发语音 | 用微信的转写文本；没有转写时把 `.silk` 原文落到 inbox 并如实告知（桥**不会**转写语音） |

### 会话控制

| 命令 | 作用 |
| --- | --- |
| `/new [标题或目录]` | 开新会话；参数是已存在目录就用它当工作目录 |
| `/list [all] [页码]` | 手机会话列表（📌 = 主会话）；`all` = 其他会话，页脚提示翻页 |
| `/channel [序号\|id]` | 查看/更换「主会话」——手机的家、`/detach` 回到的地方 |
| `/help [命令\|全部]` | 命令手册：`/help` 总览、`/help attach` 单条、`/help 全部` 全文 |
| `/attach [序号\|id]` | **跟随电脑上正在用的会话**；不带参数自动挑（正在运行的优先，其次最近更新的） |
| `/switch 序号\|短号\|标题` | 切换会话（手动切换后 5 分钟内不会被自动跟随打扰） |
| `/last` | 切回上一个会话 |
| `/current` | 当前会话详情（目录、模型、花费、最近活动） |
| `/rename 标题` | 重命名当前会话 |
| `/cancel [all]` | 中断当前任务；`all` 同时丢弃待发消息 |
| `/dir [路径]` | 查看/设置新会话的默认目录 |
| `/queue [clear]` | 看是否有卡住的消息 / 丢弃 |
| `/cost` | 当前会话花费与 token |

### 模型与 agent

| 命令 | 作用 |
| --- | --- |
| `/model` | 列出可用模型（带上下文长度与价格） |
| `/model 序号` / `/model providerID/modelID` | 切换模型 |
| `/agent` / `/agent 序号` | 查看 / 切换 agent |

### 交互

| 场景 | 做法 |
| --- | --- |
| agent 要审批 | 微信收到「🔐 需要你确认」，回 `1`=允许一次 `2`=总是允许 `3`=拒绝 |
| 多个待审批 | `/allow 序号`、`/always 序号`、`/deny 序号`、`/deny all`、`/allow all`（一次全批准） |
| agent 提问（选择题/填空） | 微信收到「❓ …」，回 `/answer 答案`；多问题用 `/answer 1=答案; 2=答案`；**同时有多个提问**用 `/answer #2 答案` 指定第几个 |
| 输入法打出全角 | 命令和数字都做 NFKC 归一：`／列表 ２`、`/attach ３` 与半角等效 |

审批和提问都会**等你回答**：回答前那一步不会继续，所以你离开电脑也不会卡死——
这是这个插件存在的主要理由。

### 手机与会话的关系

设计是「**主会话 = 手机的家**，需要时才把某个桌面会话借给手机」：

| 概念 | 含义 |
| --- | --- |
| 主会话 | 手机的家：第一条消息会建一个叫「主会话」的会话，**在手机列表里始终置顶（📌）**；`/channel` 可以换 |
| 借用（attach） | 把某个桌面会话接到手机上：手机发消息进那个会话，它的回答也到微信；**手机列表里会留下它** |
| 归还（detach） | 切回主会话；被借用的会话之后的消息不再打扰手机 |

手机上的命令：`/attach [序号|id]`、`/detach`、`/channel`。

借用的会话标题会被加上 `📱 ` 前缀（桌面端也看得见），归还时去掉 —— 这是「手机正在用它」的标记。
（早期做过的桌面按钮方案已经移除：桌面端不渲染插件插槽，改由标题标记 + 命令就够了。）

**两份列表**：`/list` 只列手机自己的会话（置顶的主会话 + 手机建过/借过的），
`/list all` 才是终端/其他会话（`/list all 2`、`/list all 3` 翻页）——这样几十条 CLI 会话不会把手机列表淹掉。

**忘了命令**：`/help` 总览、`/help attach` 看单条详情、`/help 全部` 让机器人重发完整手册；
同一份内容生成为 `MANUAL.md`（改 `manual.ts` 后跑 `bun gen-manual.ts` 重新生成）。

## 和桌面端保持一致

微信这边的会话**本来就是桌面端的那条会话**（同一条，不是镜像）：手机上发的话会成为
那条会话里的用户消息，桌面上给它打字的回答也会发到微信。

要做的是"跟得上"，所以有两个工具：

| 做法 | 效果 |
| --- | --- |
| `/attach` | 立刻绑到电脑上正在用的那条：**正在运行的会话优先**，否则取最近更新的那条 |
| `/attach 3` | 绑到 `/list` 里的第 3 条（等于 `/switch`，但会被记为"你选的"） |
| `/wechat-config follow on` | **自动跟随**：电脑上换到别的会话在干活，微信自动跟过去并告诉你 |

自动跟随故意做得保守，避免"说着话内容跑到别的会话"：

- 只跟随**最近 10 分钟有活动**的会话，不会跳到很久以前的
- 你手动 `/switch` 或 `/attach <序号>` 之后 **5 分钟内不再自动跳**
- 每次跟随都会在微信里说明跟到了哪条

`follow-hold <分钟>` 可以改那个 5 分钟；`follow off` 关掉。

### 其他

`/status` 通道状态 ｜ `/more`（`/继续`）回答没发全：补发卡住的、或让模型接着写 ｜ `/retry` 立刻重发卡住的消息 ｜ `/ping` ｜ `/whoami` ｜
`/log [行数]` ｜ `/help`

## agent 能主动找你

| 工具 | 用途 |
| --- | --- |
| `wechat_send` | 发一条文字（可带 `file` 参数一起发文件） |
| `wechat_send_file` | 发图片/视频/文件（图片按原生图片显示） |
| `wechat_ask` | **在微信里向你提问，并等你回答后再继续**（默认 10 分钟超时） |
| `wechat_status` | 查通道状态 |

所以「跑完告诉我」「做完把结果发我」「要发布前先问我」这类要求都可以直接说。
`wechat_ask` 是给别人拍板的逃生口：问题发到你手机，你回什么，答案就是工具返回值。

**其他会话**要能推送到微信（默认关闭），在 opencode 里执行 `/wechat-config mirror on`。

## 设置

`~/.config/opencode/wechat/config.json`（也可用 `/wechat-config` 改，10 秒内生效）：

```jsonc
{
  "directory": "C:\\Users\\you",   // 微信里新建会话的默认工作目录
  "progress": "tools",             // tools=每个工具调用发一行；off=只发最终回答
  "stream": "off",                 // live=边生成边发（长任务在手机上更有反馈）
  "streamIntervalMs": 8000,        // live 模式的推送间隔
  "turnGraceMs": 3000,             // 没有结束信号时最多再等多久就发送（回复延迟的上限）
  "turnSettleMs": 600,             // 收到「本轮结束」信号（session.status/…succeeded）后的确认窗
  "mirrorAll": false,              // 是否允许非微信会话推送结果到微信
  "followActive": false,           // 自动跟随电脑上正在用的会话
  "followHoldMs": 300000,          // 手动切换后多久内不被自动跟随打扰
  "followWindowMs": 600000,        // 只跟随这个时间窗内有活动的会话
  "autoTitle": true,               // 用第一条消息给会话命名
  "ack": "off",                    // text=收到消息立刻回一句「收到，开始处理…」
  "sendDelayMs": 250,              // 分片之间的间隔，太快容易被服务端拒
  "chunkSize": 3900,               // 长回答分片大小（官方上限 4000，多段会标 （1/3））
  "listLimit": 15,                 // /list 显示条数
  "allowedUsers": [],              // 微信 id 白名单；空=只允许绑定账号
  "agent": "",                     // 新会话固定用的 agent
  "model": "",                     // 新会话固定用的模型 providerID/modelID
  "askTimeoutMs": 600000,          // wechat_ask 等待回答的时限（毫秒）
  "approvalBurstMs": 800,          // 合并审批的窗口：一波多个审批只发一条消息
  "retryBackoffMs": [5000, 15000, 45000, 120000, 300000]  // 被拒后的重试退避（最后一档后停手等下次消息）
}
```

环境变量（都非必需）：

| 变量 | 作用 |
| --- | --- |
| `WECHAT_STATE_DIR` | 状态目录改到别处（默认 `~/.config/opencode/wechat`） |
| `WECHAT_SERVICE_FILE` | 显式指定 opencode 服务注册文件（`--standalone` 模式下有用） |
| `WECHAT_QR_PNG` | 登录二维码图片的输出路径 |

## 原理（为什么这样设计）

**单轮询器。** 插件在每个打开的 location 都会加载一次，它们共用一个进程。锁文件用
**独占创建**（`wx`）抢占，拿不到就每 10 秒自检一次；抢到锁的实例负责长轮询，并且每轮
自己复查所有权——失去锁的轮询循环会自行退出，不会出现两个轮询器把同一条消息各处理一遍。
锁里除心跳外还记录**轮询循环最后活动的时间**（`polledAt`，含客户端超时的空轮询）与
**服务端真实应答时间**（`answeredAt`）：心跳只说明实例活着，不说明它还在收消息。待命实例发现
`polledAt` 超过 2 分钟没动，就判定持有者卡死并接管——这是「通道突然变哑、谁都没在轮询」那类
故障的自愈机制（真机遇到过三次）；而 `answeredAt` 长期不动、`timeouts`（连续无应答次数）在涨，
说明请求发得出去、回应回不来（门户认证掉了、网络在丢包），`verify.ts` 会把这种情况指出来。

**消息去重。** 收到的 `message_id` 记在状态文件里（最近 200 条），重复投递直接忽略：
重复投递的代价是一次真实的模型调用。

**回复窗口。** 服务端给机器人的回复窗口跟着「用户发来的那条消息」走。窗口关闭后再发会
得到 `errcode=-2 errmsg=prepare failed`。插件此时把内容入队，按 5s → 15s → 45s → 2min →
5min 退避重试，并且**你下次发消息时立刻补发**。

**游标先落盘。** 长轮询游标在处理消息之前就写入状态文件，进程崩了是重放而不是丢消息。

**回复按轮发送，但不干等。** 微信不能编辑消息，逐字流式只会刷屏，所以默认攒一整轮再发
（`stream: live` 可以打开实时推送）。结束判断按可靠性从高到低：`session.status`（`status.type: "idle"`）与
`session.execution.succeeded`（v2 的正式结束信号）→ 只等 `turnSettleMs`（默认 0.6 秒）确认窗；
**每一步结束**（`session.step.ended`）也当作加速提示（同样 0.6 秒，但一旦后面有工具调用或新文本就撤销，
所以多步回答不会被切碎）；真的什么信号都没有时，才退回 `turnGraceMs`（默认 3 秒）兜底。
日志 `reply sent (trigger: idle|step|timer)` 能看出走的是哪条路（`timer` = 兜底）。

**本地 API。** 插件上下文没有「会话列表」和「表单回复」这两块能力，于是插件直接读
`~/.local/state/opencode/service.json`（`$XDG_STATE_HOME` 优先，`WECHAT_SERVICE_FILE` 可覆盖）
里的地址与密码，用 HTTP Basic 调用本机 opencode API。

## 与其它插件共存

同一台机器上装多个 opencode 插件是常态，这个插件专门做了几件事避免互相干扰：

- **单轮询器锁**：无论打开多少个项目窗口（每个都会加载一份插件实例），同一时刻只有一个实例在轮询微信；持有者卡死 2 分钟内会被其它实例自动接管。
- **提问等待不会被"假死恢复"打断**：`wechat_ask` 等待人工回答期间，每 60 秒上报一次工具进度（`session.tool.progress`），装了多少"会话卡住就自动 continue"的恢复类插件都不会把等待误判成挂起。
- **`/cancel` 与自动续跑语义一致**：取消后不会被自动恢复插件重新拉起，直到你再次发言。
- **不吃别人的工具**：`🔧` 进度只播报真正的干活工具，别的插件的簿记工具（如 `task_complete`）不会出现在微信里。
- **状态文件各用各的**：插件只写 `~/.config/opencode/wechat/`（以及读取 opencode 自己的 service.json），与其它插件的存储、日志、命令、工具命名均不重叠。

实测共存过的插件：oh-my-opencode-slim、@tarquinen/opencode-dcp、opencode-i18n-v2、auto-resume-v2（本地）。如果你发现新的冲突，日志 `bridge.log` 里搜 `event type seen for the first time` 通常能找到线索。

## 排查

```powershell
bun $env:USERPROFILE\.config\opencode\plugins\wechat\verify.ts
```

它会检查依赖、登录、目录、锁、本地 API 与最近告警。日志在
`~/.config/opencode/wechat/bridge.log`；微信里发 `/status`、`/log` 也能看。

| 症状 | 原因与处理 |
| --- | --- |
| 发消息没反应 | 日志里没有 `poller started`：先登录。锁有心跳但 `polledAt` 很旧：2 分钟内会被别的实例接管 |
| 电脑上答完、微信慢半分钟 | 正常路径是"结束信号 / 步结束 + `turnSettleMs`（0.6 秒）"；只有什么信号都没来才等 `turnGraceMs`（3 秒）再加被拒重试的退避。日志 `reply sent (trigger: …)` 能看出走的是哪条路 |
| 回答没回到微信 | 日志找 `send refused`；`-2 prepare failed` 是窗口关了（会自动补发），`-14` 是 token 失效 |
| 回答只发了一半 | 多段回答会标 `（1/3）（2/3）…`，缺号就是被限流了：发 `/more` 补发（有卡住的东西时**只补发、不叫模型**）；确实没写完再发一次 `/more` 让模型续写 |
| 手机收到灰框图片 | `aes_key` 编码错了（必须是 hex 文本的 base64）——本插件已对齐，若出现请提 issue |
| `/list` 看不到桌面会话 | 本地 API 不可用（`verify.ts` 会指出来），此时只列微信建过的会话 |
| 同一条消息处理两次 | 正常不会：有 `message_id` 去重 + 单轮询器 |
| 电脑休眠/断网 | 唤醒后自动重连，游标已落盘，消息不会丢 |

> **改了支持模块要 touch 入口。** opencode 的热重载以插件入口为触发点；只改
> `bridge.ts`、`state.ts` 这些被 import 的模块时可能仍在跑旧代码——保存一次
> `index.ts` 即可（或 `opencode service restart`）。

## 开发

```powershell
cd $env:USERPROFILE\.config\opencode\plugins\wechat
cd types; bun install    # 一次性：类型检查用的官方类型（types/ 被 gitignore）
bun test                 # 205 个测试：单元 + mock iLink + 假 ctx 驱动的 Bridge 行为
bun run typecheck        # strict 检查（缺依赖时会提示上面那句安装命令）
bun verify.ts            # 环境自检
bun gen-manual.ts        # 改了 manual.ts 之后重新生成 MANUAL.md
```

三层测试各自负责一段：

| 文件 | 覆盖 |
| --- | --- |
| `tests/unit.test.ts` | 纯逻辑：分片、转义、密钥解码、审批/表单解析、会话解析、配置守卫、轮询锁抢占/接管、`unwrap` 形状 |
| `tests/integration.test.ts` | 协议层打 mock iLink：登录握手、长轮询、游标落盘、报文形状、媒体加密上传、拒收、本地 API 的 Basic 认证与 204/500 |
| `tests/bridge.test.ts` | **Bridge 行为**：假 ctx + mock iLink + mock API，把 `/switch` `/rename` `/model` `/cancel` `/answer` `/queue` `/last` 等命令、审批合并、流式、回复窗口、`wechat_ask`、重连自愈、`mirrorAll` 全部跑一遍 |

类型检查用的是官方包，装在 `types/` 子目录里（`types/package.json`）。放在子目录是有意的：
插件运行时必须用宿主注入的那份 `@opencode/plugin`，`types/` 不在模块解析路径上，所以不会被误用。

`bunfig.toml` 的 `tests/preload.ts` 会把状态目录指到临时目录，
所以**直接 `bun test` 也不会碰你的真实凭据**。

`WECHAT_STATE_DIR` 可以把状态目录指到别处，`WECHAT_SERVICE_FILE` 可以指定服务注册文件
（测试就是这么隔离的）。

### 改代码时的两个坑

**1. 以生成的客户端类型为准，不要照抄文档示例。** 官方文档里 `ctx.permission.reply`
写的是 `reply: "once"`，而生成的客户端类型是 `decision` —— 传错字段名不会报错，
请求会静静地什么都不做（这个 bug 真出现过：审批回复后请求一直挂在待办里）。
校验字段名的办法：

```powershell
# ctx 的各个 domain 就来自这里
Select-String -Path ~/.config/opencode/node_modules/@opencode/client/dist/promise/generated/types.d.ts `
  -Pattern "PermissionReplyInput" -Context 0,12
```

**2. 改完支持模块要 touch 入口**，否则热重载可能还在跑旧代码（见上面的排查小节）。

## 验证状态

真机（腾讯服务端）验证过的路径：

| 方向 | 路径 | 证据 |
| --- | --- | --- |
| 收到文字 | 长轮询 → 会话 | 日志 `inbound` + 会话里的用户消息 |
| 收到图片 | CDN 下载 → AES 解密 → 落盘 → 图片交给模型 | 文件头 `ffd8ffe0…`（真 JPEG）+ 模型准确描述了截图内容 |
| 收到文件/视频 | 同上 | 同一代码路径，集成测试覆盖 |
| 回答回流 | agent 回答 → 微信 | 日志 `sent N chars`，用户收到并继续对话 |
| 主动发文字 | `wechat_send` | 用户收到 |
| 主动发图片 | 加密 → CDN 上传 → 原生图片 | 日志 `sent image …`，用户收到 |
| 主动发文件 | 同上（文件卡片） | 日志 `sent file …`，用户收到 |
| 提问并等待 | `wechat_ask` → 用户回答 → 工具返回 | 回答文本成为工具返回值 |
| 审批中转 | 推送 → 回 `1` → 兑现 | 待办从 1 变 0，收到「✅ 已回复」 |
| 表单问答 | 推送 → `/answer` → 提交 | 服务端 state 变 `answered`，答案与输入一致 |
| 命令 | `/status` `/list` `/model`（40/73）`/agent` `/cost` `/switch` `/answer` | 每条都有对应的 `sent` 记录 |
| 模型切换 | 会话 model 字段被改写 | 端点返回 204，字段确认更新 |

未在真机上跑过、但代码路径与已验证部分共用：`/cancel`、`/rename`、`/dir`、`/retry`、`/more`、
`/log`、`/ping`、`/whoami`。**新命令（翻页 `/list 2`、`/list all 2`、
`/channel 序号`、`/help 命令`/`/help 全部`、`/attach 序号` 接管 CLI 会话）由测试覆盖**，等你在
微信里实际用过一次就会补进上表。

自动化测试：`bun test` —— 单元测试 + mock iLink 服务端集成测试（登录握手、长轮询、游标落盘、
报文形状、媒体加密上传与 `x-encrypted-param` 回读、拒收处理、本地 API 的 Basic 认证、
204 与 500 的区分、表单回复），加上 Bridge 行为测试里的轮询锁抢占/接管、idle 与兜底定时器的
投递时机、命令手册、会话列表翻页。

## 安全

- **非官方项目**：与腾讯、微信、opencode 官方均无关联，用的是微信 ClawBot 的 iLink 机器人协议，
  仅供个人在自己的账号上使用。
- 只连腾讯官方 iLink 网关（`ilinkai.weixin.qq.com` 及其返回的同一 IDC 主机），没有第三方中转。
- 扫码后 bot 与你的微信号是密码学绑定的：服务端只投递这一个账号的消息，机器人不是微信
  联系人、搜不到、别人加不了。想再加一层，用 `allowedUsers` 白名单。
- 凭据只存本地（POSIX 上 0600、Windows 上继承用户目录 ACL，放在 `~/.config/opencode/wechat/`，**不在本仓库里**），不写入任何仓库。
- **agent 以你的身份运行**：微信来的会话默认继承你的权限设置，需要审批的会发到微信。
  想让 agent 干活更顺，放宽默认 agent 的权限；想更稳，保持审批开着。

## 限制

- 只处理单聊；群聊消息忽略（ClawBot 协议本身也只声明私聊），入站消息带 `group_id` 时直接丢掉。
- 出站支持文本、图片、视频、文件；**语音发送**未实现。接收侧优先用微信转写文本，没有转写时
  把 `.silk` 原文存进 inbox 并在提示里说明「桥不转写」（要转写请自己接一个 ASR）。
- agent 的提问（form）走本地 API，因此在 `--standalone` 模式下如果注册文件指向别的进程，
  提问需要回电脑回答。
- opencode v2 插件 API 目前是 beta，接口变化时需要跟着改。
- 微信会话建在**默认目录**（默认 `~`）里，所以它出现在那个目录对应的 opencode 项目下。
  想让它长在某个仓库里，先 `/dir D:\code\repo` 再 `/new`。
- **发送超时不会重复投递**：每条待发消息带一个稳定的 `client_id`（重试、上下文回退、插件重载都复用同一个），
  服务端按它去重。所以"宁可重复也不丢"的取舍已经不适用：超时会重试，但不会到两次。
- 接收到的附件在 `~/.config/opencode/wechat/inbox`：保留 **14 天或 512MB**（先到者为准），旧的自动清理。
