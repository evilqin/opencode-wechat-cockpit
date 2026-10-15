/**
 * The WeChat-side command manual.
 *
 * One source of truth for three surfaces:
 *  - `/help`            the grouped overview,
 *  - `/help <命令>`      one command's card,
 *  - `/help 全部`        the complete manual,
 * and `gen-manual.ts` renders the same data into MANUAL.md, so the file that
 * ships next to the plugin can never drift from what the bot answers.
 */

export interface CommandDoc {
  /** Canonical spelling, with the leading slash. */
  name: string
  /** Other spellings that reach the same handler. */
  aliases: string[]
  /** One-line answer to "what is this for". */
  summary: string
  /** How to call it. */
  usage: string
  /** Copy-pasteable examples. */
  examples?: string[]
  /** Behaviour worth spelling out before it surprises someone. */
  notes?: string[]
}

export const COMMAND_DOCS: CommandDoc[] = [
  {
    name: "/help",
    aliases: ["/?", "/帮助", "/手册"],
    summary: "这个手册：总览、单条命令、或完整版",
    usage: "/help [命令|全部]",
    examples: ["/help", "/help attach", "/help 全部"],
    notes: ["忘命令了就发 /help；单条命令也可以发 /help list 这样"],
  },
  {
    name: "/new",
    aliases: ["/新"],
    summary: "开一条新会话，并把手机切过去",
    usage: "/new [标题或目录]",
    examples: ["/new", "/new 修复登录流程", "/new D:\\code\\project"],
    notes: [
      "参数是已存在的目录 → 用它当工作目录（相对路径按当前会话目录算；可写 ~ 或加引号）",
      "否则当作标题",
      "不给参数：用默认目录（见 /dir），标题从你第一句话自动生成",
    ],
  },
  {
    name: "/list",
    aliases: ["/列表"],
    summary: "会话列表；all = 手机不拥有的其他会话（终端/桌面建的）",
    usage: "/list [all] [页码]",
    examples: ["/list", "/list 2", "/list all", "/list all 2"],
    notes: [
      "▶ = 你正在用的会话；📌 = 主会话（/detach 回到它）",
      "序号是全局的：翻到第 2 页后，照样直接 /attach 那个号",
      "页脚有翻页提示；最多读取 200 条会话",
    ],
  },
  {
    name: "/attach",
    aliases: ["/follow", "/跟随"],
    summary: "把某条会话接到手机（借用它，手机消息开始进它）",
    usage: "/attach [序号|id]",
    examples: ["/attach", "/attach 3", "/attach ses_ed503403"],
    notes: [
      "不带参数：自动挑电脑上**正在运行**的会话，其次最近更新的那条",
      "带序号：序号按你最近一次看的列表算 —— 先发 /list all 再挑",
      "接手后该会话标题会带 📱 前缀（桌面端也看得见）",
      "用 /detach 归还，不归还就一直用着",
    ],
  },
  {
    name: "/detach",
    aliases: ["/断开", "/释放"],
    summary: "归还借用的会话，回到主会话",
    usage: "/detach",
    notes: ["归还后那条会话的新消息不再发到手机", "没借用任何会话时发它，就是回主会话"],
  },
  {
    name: "/channel",
    aliases: ["/通道"],
    summary: '看/改"主会话"（手机的家：没借别人时待着、/detach 回到的地方）',
    usage: "/channel [序号|id|标题]",
    examples: ["/channel", "/channel 2", "/channel 微信助手"],
    notes: [
      "改家 ≠ 立刻换聊天对象；想立刻换过去用 /attach",
      "新的家会置顶 📌，并记进手机列表",
    ],
  },
  {
    name: "/switch",
    aliases: ["/切换"],
    summary: "切换会话（和 /attach 类似，语义是「切过去」）",
    usage: "/switch 序号|短号|标题",
    examples: ["/switch 2", "/switch a1b2c3d4", "/switch 修复登录"],
    notes: [
      "序号按最近一次列表；短号是会话 id 的结尾几位；标题对得上也能切",
      "和 /attach 的区别：/switch 不强调「借用/归还」这层语义",
      "手动切换后 5 分钟内不会被自动跟随打扰（follow-hold 可改）",
    ],
  },
  {
    name: "/last",
    aliases: ["/back", "/切回"],
    summary: "切回上一个会话（切换前的那个）",
    usage: "/last",
  },
  {
    name: "/current",
    aliases: ["/当前"],
    summary: "看当前会话详情（标题、目录、编号）",
    usage: "/current",
    notes: ["不确定手机在跟哪条会话说话时，发它"],
  },
  {
    name: "/rename",
    aliases: ["/重命名"],
    summary: "给当前会话改名（桌面端同步可见）",
    usage: "/rename 新标题",
    examples: ["/rename 微信助手"],
  },
  {
    name: "/cancel",
    aliases: ["/stop", "/停"],
    summary: "中断当前正在跑的任务；all 顺带丢掉待发消息",
    usage: "/cancel [all]",
    examples: ["/cancel", "/cancel all"],
    notes: ["任务卡住或跑偏时用它，不必等它自己跑完"],
  },
  {
    name: "/queue",
    aliases: ["/队列"],
    summary: "看待发消息（被微信拒收、等你说话后补发的那些）；clear 丢弃",
    usage: "/queue [clear]",
    examples: ["/queue", "/queue clear"],
    notes: ["补发时机：你发下一条消息，或者 /retry"],
  },
  {
    name: "/retry",
    aliases: [],
    summary: "立刻重试待发队列，不等下一条消息",
    usage: "/retry",
  },
  {
    name: "/more",
    aliases: ["/继续", "/接着"],
    summary: "回答没发全时用它：卡住的补发；确实没写完就让模型接着写",
    usage: "/more",
    notes: [
      "有没发出去的内容：只补发，**不会调用模型**（不花 token、不污染上下文）",
      "队列是空的：让模型从中断处续写，而不是把你的话当新问题回答",
      "多段回答会标 （1/3）（2/3）…，看到缺号就直接发 /more",
    ],
  },
  {
    name: "/model",
    aliases: ["/模型"],
    summary: "看/切换模型",
    usage: "/model [序号|providerID/modelID]",
    examples: ["/model", "/model 3", "/model providerID/modelID"],
    notes: ["不带参数就列出来（带上下文长度和价格）；序号按那次列表算"],
  },
  {
    name: "/agent",
    aliases: [],
    summary: "看/切换 agent（build / plan …）",
    usage: "/agent [序号|id|名称]",
    examples: ["/agent", "/agent 2", "/agent build"],
  },
  {
    name: "/cost",
    aliases: ["/花费"],
    summary: "当前会话的花费与 token 用量",
    usage: "/cost",
  },
  {
    name: "/allow",
    aliases: ["/允许"],
    summary: "批准一次待审批的操作（默认第一条）",
    usage: "/allow [序号|all]",
    examples: ["/allow", "/allow 2", "/allow all"],
    notes: [
      "也可以直接回数字：1=允许一次 2=总是允许 3=拒绝（有待回答的提问时，先回答提问）",
      "all = 一次批准所有待审批",
    ],
  },
  {
    name: "/always",
    aliases: [],
    summary: "总是允许（同类操作以后不再问）",
    usage: "/always [序号|all]",
    examples: ["/always", "/always 2", "/always all"],
  },
  {
    name: "/deny",
    aliases: ["/拒绝"],
    summary: "拒绝待审批的操作",
    usage: "/deny [序号|all]",
    examples: ["/deny", "/deny all"],
  },
  {
    name: "/answer",
    aliases: ["/答"],
    summary: "回答 agent 的提问（表单）",
    usage: "/answer [#序号] 答案",
    examples: ["/answer pnpm", "/answer 1=2；2=是", "/answer #2 第二个问题的答案"],
    notes: [
      "选择题回选项号或选项文字；多题用 1=…；2=… 的形式",
      "有多个提问时用 /answer #2 指定第几个（默认第一个）",
    ],
  },
  {
    name: "/dir",
    aliases: ["/目录"],
    summary: "看/设新会话的默认工作目录",
    usage: "/dir [路径]",
    examples: ["/dir", "/dir D:\\code\\project", '/dir "D:\\code\\my repo"'],
    notes: ["可以写 ~；相对路径按当前会话目录算（回显的一定是解析后的绝对路径）"],
  },
  {
    name: "/status",
    aliases: ["/状态"],
    summary: "通道状态：登录、轮询、绑定、队列、待办数量",
    usage: "/status",
  },
  {
    name: "/log",
    aliases: ["/日志"],
    summary: "看桥的最近日志（排查问题时用）",
    usage: "/log [行数]",
    examples: ["/log", "/log 80"],
  },
  { name: "/ping", aliases: [], summary: "测通道是否活着", usage: "/ping" },
  {
    name: "/whoami",
    aliases: [],
    summary: "看你的微信标识和白名单设置",
    usage: "/whoami",
  },
]

/** The grouped overview `/help` answers without an argument. */
export const HELP_TEXT = [
  "🤖 opencode 微信通道",
  "",
  "直接发消息 = 交给当前会话；发图片/文件会自动落盘再交给它。",
  "",
  "会话",
  "/new [标题或目录]  开新会话（参数是已存在目录就用它当工作目录）",
  "/list [all] [页码] 手机会话列表（📌 = 主会话）；all = 其他会话，可翻页",
  "/attach [序号|id]    把某个会话接到手机（不带参数 = 接电脑正在用的）",
  "/detach            切回主会话（不再接收被接管会话的消息）",
  "/channel [序号|id]  查看/设置主会话（手机默认待的会话）",
  "/switch 序号|短号|标题  切换会话",
  "/last              切回上一个会话",
  "/current           当前会话详情",
  "/rename 标题       重命名",
  "/cancel [all]      中断当前任务",
  "/dir [路径]        查看/设置新会话的默认目录",
  "/queue [clear]     看待发消息 / 丢弃",
  "",
  "模型与用量",
  "/model [序号]      查看/切换模型（也可 /model providerID/modelID）",
  "/agent [序号|id]   查看/切换 agent",
  "/cost              当前会话花费与 token",
  "",
  "交互",
  "/allow [序号|all]   允许一次（默认第一个待审批）",
  "/always [序号|all]  总是允许",
  "/deny [序号|all]    拒绝（all = 全部）",
  "/answer #n 答案     回答 agent 的提问（多个时用 #2 指定）",
  "",
  "其他",
  "/more [继续|接着]   回答没发全：补发卡住的 / 让模型接着写",
  "/status /retry /ping /whoami /log [行数] /help",
  "",
  "电脑上的命令（在 opencode 里输入）",
  "/wechat-login 扫码登录 ｜ /wechat-attach 把当前会话接到手机",
  "/wechat-detach 还回去 ｜ /wechat-status 状态 ｜ /wechat-config 设置",
  "",
  "审批也可以直接回数字：1=允许一次 2=总是允许 3=拒绝",
  "命令详情：/help 命令（如 /help attach）；完整手册：/help 全部",
].join("\n")

/** Strip slashes and punctuation so `/Attach`, `attach？` both match. */
function bareName(argument: string): string {
  return argument
    .trim()
    .toLowerCase()
    .replace(/^[／/]+/, "")
    .replace(/[?？!！。:：]+$/, "")
}

/** Find a command's card by any of its spellings. */
export function resolveCommandDoc(argument: string): CommandDoc | undefined {
  const wanted = bareName(argument)
  if (!wanted) return undefined
  return COMMAND_DOCS.find((doc) => [doc.name, ...doc.aliases].some((name) => bareName(name) === wanted))
}

/** One command's card, as sent to WeChat. */
export function renderCommandDoc(doc: CommandDoc): string {
  const lines = [
    `📖 ${doc.name}${doc.aliases.length > 0 ? `（也写作 ${doc.aliases.join(" ")}）` : ""}`,
    `说明：${doc.summary}`,
    `用法：${doc.usage}`,
  ]
  if (doc.examples?.length) lines.push("例子：", ...doc.examples.map((example) => `  ${example}`))
  if (doc.notes?.length) lines.push("注意：", ...doc.notes.map((note) => `  · ${note}`))
  return lines.join("\n")
}

/** Everything, for `/help 全部` and MANUAL.md. */
export function renderManual(): string {
  return [
    "📚 opencode 微信命令手册",
    "（这份手册也在电脑上：插件目录 MANUAL.md；随时 /help 命令 查单条）",
    "",
    HELP_TEXT,
    "",
    "────────── 逐条详解 ──────────",
    "",
    COMMAND_DOCS.map(renderCommandDoc).join("\n\n"),
  ].join("\n")
}
