# opencode 微信命令手册

> 由 `gen-manual.ts` 从 `manual.ts` 生成 —— 想改手册，改 `manual.ts` 再跑 `bun gen-manual.ts`。
> 微信里随时可以发 `/help` 看总览、`/help 命令` 看单条、`/help 全部` 让机器人重发这份全文。

## 总览（= 微信里发的 `/help`）

```text
🤖 opencode 微信通道

直接发消息 = 交给当前会话；发图片/文件会自动落盘再交给它。

会话
/new [标题或目录]  开新会话（参数是已存在目录就用它当工作目录）
/list [all] [页码] 手机会话列表（📌 = 主会话）；all = 其他会话，可翻页
/attach [序号|id]    把某个会话接到手机（不带参数 = 接电脑正在用的）
/detach            切回主会话（不再接收被接管会话的消息）
/channel [id]      查看/设置主会话（手机默认待的会话）
/switch 序号|短号|标题  切换会话
/last              切回上一个会话
/current           当前会话详情
/rename 标题       重命名
/cancel [all]      中断当前任务
/dir [路径]        查看/设置新会话的默认目录
/queue [clear]     看待发消息 / 丢弃

模型与用量
/model [序号]      查看/切换模型（也可 /model providerID/modelID）
/agent [序号]      查看/切换 agent
/cost              当前会话花费与 token

交互
/allow [序号]      允许一次（默认第一个待审批）
/always [序号]     总是允许
/deny [序号]       拒绝（all = 全部）
/answer 答案       回答 agent 的提问

其他
/more [继续|接着]   回答没发全：补发卡住的 / 让模型接着写
/status /retry /ping /whoami /log [行数] /help

电脑上的命令（在 opencode 里输入）
/wechat-login 扫码登录 ｜ /wechat-attach 把当前会话接到手机
/wechat-detach 还回去 ｜ /wechat-status 状态 ｜ /wechat-config 设置

审批也可以直接回数字：1=允许一次 2=总是允许 3=拒绝
命令详情：/help 命令（如 /help attach）；完整手册：/help 全部
```

## 逐条详解

### /help

这个手册：总览、单条命令、或完整版

```text
用法：/help [命令|全部]
别名：/? /帮助 /手册
```
例子：

- `/help`
- `/help attach`
- `/help 全部`

注意：

- 忘命令了就发 /help；单条命令也可以发 /help list 这样

### /new

开一条新会话，并把手机切过去

```text
用法：/new [标题或目录]
别名：/新
```
例子：

- `/new`
- `/new 修复登录流程`
- `/new D:\code\project`

注意：

- 参数是已存在的目录 → 用它当工作目录；否则当作标题
- 不给参数：用默认目录（见 /dir），标题从你第一句话自动生成

### /list

会话列表；all = 手机不拥有的其他会话（终端/桌面建的）

```text
用法：/list [all] [页码]
别名：/列表
```
例子：

- `/list`
- `/list 2`
- `/list all`
- `/list all 2`

注意：

- ▶ = 你正在用的会话；📌 = 主会话（/detach 回到它）
- 序号是全局的：翻到第 2 页后，照样直接 /attach 那个号
- 页脚有翻页提示；最多读取 200 条会话

### /attach

把某条会话接到手机（借用它，手机消息开始进它）

```text
用法：/attach [序号|id]
别名：/follow /跟随
```
例子：

- `/attach`
- `/attach 3`
- `/attach ses_ed503403`

注意：

- 不带参数：自动挑电脑上**正在运行**的会话，其次最近更新的那条
- 带序号：序号按你最近一次看的列表算 —— 先发 /list all 再挑
- 接手后该会话标题会带 📱 前缀（桌面端也看得见）
- 用 /detach 归还，不归还就一直用着

### /detach

归还借用的会话，回到主会话

```text
用法：/detach
别名：/断开 /释放
```
注意：

- 归还后那条会话的新消息不再发到手机
- 没借用任何会话时发它，就是回主会话

### /channel

看/改"主会话"（手机的家：没借别人时待着、/detach 回到的地方）

```text
用法：/channel [序号|id]
别名：/通道
```
例子：

- `/channel`
- `/channel 2`

注意：

- 改家 ≠ 立刻换聊天对象；想立刻换过去用 /attach
- 新的家会置顶 📌，并记进手机列表

### /switch

切换会话（和 /attach 类似，语义是「切过去」）

```text
用法：/switch 序号|短号|标题
别名：/切换
```
例子：

- `/switch 2`
- `/switch a1b2c3d4`
- `/switch 修复登录`

注意：

- 序号按最近一次列表；短号是会话 id 的结尾几位；标题对得上也能切
- 和 /attach 的区别：/switch 不强调「借用/归还」这层语义
- 手动切换后 5 分钟内不会被自动跟随打扰（follow-hold 可改）

### /last

切回上一个会话（切换前的那个）

```text
用法：/last
别名：/back /切回
```
### /current

看当前会话详情（标题、目录、编号）

```text
用法：/current
别名：/当前
```
注意：

- 不确定手机在跟哪条会话说话时，发它

### /rename

给当前会话改名（桌面端同步可见）

```text
用法：/rename 新标题
别名：/重命名
```
例子：

- `/rename 微信助手`

### /cancel

中断当前正在跑的任务；all 顺带丢掉待发消息

```text
用法：/cancel [all]
别名：/stop /停
```
例子：

- `/cancel`
- `/cancel all`

注意：

- 任务卡住或跑偏时用它，不必等它自己跑完

### /queue

看待发消息（被微信拒收、等你说话后补发的那些）；clear 丢弃

```text
用法：/queue [clear]
别名：/队列
```
例子：

- `/queue`
- `/queue clear`

注意：

- 补发时机：你发下一条消息，或者 /retry

### /retry

立刻重试待发队列，不等下一条消息

```text
用法：/retry
```
### /more

回答没发全时用它：卡住的补发；确实没写完就让模型接着写

```text
用法：/more
别名：/继续 /接着
```
注意：

- 有没发出去的内容：只补发，**不会调用模型**（不花 token、不污染上下文）
- 队列是空的：让模型从中断处续写，而不是把你的话当新问题回答
- 多段回答会标 （1/3）（2/3）…，看到缺号就直接发 /more

### /model

看/切换模型

```text
用法：/model [序号|providerID/modelID]
别名：/模型
```
例子：

- `/model`
- `/model 3`
- `/model providerID/modelID`

注意：

- 不带参数就列出来（带上下文长度和价格）；序号按那次列表算

### /agent

看/切换 agent（build / plan …）

```text
用法：/agent [序号]
```
例子：

- `/agent`
- `/agent 2`

### /cost

当前会话的花费与 token 用量

```text
用法：/cost
别名：/花费
```
### /allow

批准一次待审批的操作（默认第一条）

```text
用法：/allow [序号]
别名：/允许
```
注意：

- 也可以直接回数字：1=允许一次 2=总是允许 3=拒绝

### /always

总是允许（同类操作以后不再问）

```text
用法：/always [序号]
```
### /deny

拒绝待审批的操作

```text
用法：/deny [序号|all]
别名：/拒绝
```
例子：

- `/deny`
- `/deny all`

### /answer

回答 agent 的提问（表单）

```text
用法：/answer 答案
别名：/答
```
例子：

- `/answer pnpm`
- `/answer 1=2；2=是`

注意：

- 选择题回选项号或选项文字；多题用 1=…；2=… 的形式

### /dir

看/设新会话的默认工作目录

```text
用法：/dir [路径]
别名：/目录
```
例子：

- `/dir`
- `/dir D:\code\project`

### /status

通道状态：登录、轮询、绑定、队列、待办数量

```text
用法：/status
别名：/状态
```
### /log

看桥的最近日志（排查问题时用）

```text
用法：/log [行数]
别名：/日志
```
例子：

- `/log`
- `/log 80`

### /ping

测通道是否活着

```text
用法：/ping
```
### /whoami

看你的微信标识和白名单设置

```text
用法：/whoami
```
