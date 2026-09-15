# DSH 事件 → 灯状态 详细对应表

本文档是**权威映射表**，与插件源码 `plugin/lib/index.js` 与固件
`firmware/esp32c3_dsh_status_light/esp32c3_dsh_status_light.ino` 一一对应。

- DSH 的事件名取自本机安装的 `@deepseek-ai/dsh-session` 的
  `lib/types/known-event-types.js`（**共 56 种事件类型**，实测枚举得出）。
- “灯状态”一列是 ESP32-C3 红绿灯实际显示的效果。
- “当前实现”一列标明插件是否已处理；标 `忽略` 的是按约定**刻意不处理**的。

---

## 一、核心状态一览（6 个前景 + 2 个修饰）

### 前景状态

| 固件收到的命令 | 灯效 | 含义 |
|---|---|---|
| `thinking` | 🟡 黄灯**呼吸**（周期 2.4 秒） | 模型正在思考/生成 |
| `alarm` | 🟡 黄灯**快闪**（周期 0.28 秒） | **在等你确认**（权限申请等） |
| `success` | 🟢 绿灯**常亮** | 一轮任务完成 |
| `error` | 🔴 红灯**常亮** | 出错 / 模型重试 |
| `off` | ⚫ **全灭** | 待机 |

### 工具在执行（独立命令，与前景状态正交）

`tool/call` 这类事件**不占用前景状态** —— 因为它表达的是"有工具在跑"，
与前景区分开才不会互相顶掉。插件只在「从无到有」和「从有到无」时各报一次。

| 命令 | 灯效 |
|---|---|
| `tools on` | 🟡 黄灯呼吸 **+** 🟢 绿灯**同时呼吸**（相位错开半周期） |
| `tools off` | 绿灯**不立即熄灭** —— 固件走完一个完整呼吸周期（2.4 秒）才灭 |

**为什么是"错相呼吸"而不是绿灯常亮**：常亮会与计划模式的绿灯常亮撞车，分不出来。

**为什么尾巴在固件里**：见 [`../README.md`](../README.md) 的「工具在执行」一节 ——
简言之，灯效时序归固件，插件一崩也能自己收尾。

### 背景修饰：计划模式

计划模式**不是一个灯状态**，而是一个**叠加在背景上的修饰**：它让**绿灯常亮**，
同时不影响黄灯和红灯各自工作。

**这一点能成立，是因为灯板是三颗物理独立的灯珠** —— 黄灯和绿灯同时亮是两个
真实可见的颜色，不会混色（混色只会发生在单颗 RGB 灯珠上，比如 WS2812）。

| 组合 | 显示 |
|---|---|
| `plan` | 🟢 绿灯常亮 |
| `thinking+plan` | 🟡 黄灯呼吸 **+** 🟢 绿灯常亮 |
| `thinking+plan` 且 `tools on` | 🟡 黄灯呼吸 **+** 🟢 绿灯常亮（计划模式的常亮覆盖工具呼吸） |
| `alarm+plan` | 🟡 黄灯快闪 **+** 🟢 绿灯常亮 |
| `error+plan` | 🔴 红灯常亮 **+** 🟢 绿灯常亮 |
| `success+plan` | 🟢 绿灯常亮 |

### 只闪不改状态的通知

固件的 `notify` 命令：绿灯快闪两下（**0.15s 亮 / 0.15s 灭 × 2**，共 0.6 秒）。
闪烁期间固件**强制只亮绿灯并独占控制权**，所以即使背景本来就是常亮绿灯，
这两下闪烁依然清晰可见。

- `notify <state>`：闪完自动切到 `<state>`
- `notify`：闪完回到闪烁前的状态
- ⚠️ 但若闪烁窗口（0.6 秒）内**有别的状态命令真的改变了状态**，闪完落到**那个新状态**
  （即"最新命令赢"），不回滚。详见下方"闪烁期间的状态命令"。

### 闪烁期间的状态命令

固件的 `loop()` 是**先解析执行命令、后进闪烁覆盖层**，所以闪烁期间到达的状态命令
**照常执行**。早期版本会在这个窗口结束时把它覆盖回"闪烁前的状态"——那是个 bug：

```
thinking ──notify──▶ 开始闪 ──turn/end──▶ 灯切绿 ──闪完──▶ 退回黄呼吸  ← 错
```

而插件那边认为状态已是 `success`、去重后不再重发 → 灯会一直错到下一次真实状态变化。

**已修**（两处，缺一不可）：

1. 状态真的改变时**作废那份快照**；
2. 闪烁结束时若**快照与目标都为空**，**保持现状、不调 `applyCommand`**。

第 2 条是后来补的坑：只做第 1 条时，结束分支仍会走 `target = "off"` 兜底，
把刚设好的新状态**打成全灭**（真机实测：窗口内发 `error` → 红灯亮起 → 闪完变全灭）。
当时的注释还写着"`applyCommand("off")` 恰好等于当前状态、无害"——那是错的。

只在**值真的变了**时才作废 —— 重复的同值命令仍保持"闪完回到闪烁前状态"的语义。

**诊断**：往板子发 `state?` 可以读出内部状态与三颗灯当前的效果枚举，
不必靠肉眼看灯。它会回 `saved=`、`after=`，以及 **`savedcleared=`（累计作废次数）**。

> `savedcleared` 是刻意加的：一次 `state?` 查询本身要几百毫秒，而闪烁窗口只有 600ms，
> 所以**没法靠观察 `saved=` 来判断作废有没有发生**（查询经常落在窗口之外）。
> 累计计数器不受查询时机影响 —— 跑完序列再读，次数增加就证明那条路径被执行过。
> 实测正是这个计数器戳穿了两个假象：一次"测试通过但其实没撞上窗口"的假阳性，
> 以及一次"修复只做了一半"的漏修。

**优先级**：`alarm` 最高 —— 在等你确认期间，其他事件不会把灯顶掉。
**安全兜底**：`alarm` 超 60 秒无人处理自动回落（插件侧）；空闲 5 分钟自动全灭（**固件侧**，见第五节）。


---

## 二、当前已实现的映射（23 个事件）

### → `thinking`（黄灯呼吸）

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `turn/start` | 一轮对话开始 | 你刚发出消息 |
| `step/start` | 一个“步”开始 | 模型准备动作 |
| `step/end` | 一个“步”结束 | 下一步通常仍在同一轮里 |
| `assistant/attempt` | **真正发起了一次模型请求** | 这才是“在思考”的核心信号 |
| `assistant/message` | 模型回复落地 | 生成完成，进入下一步 |

### → `tools on`（绿灯开始同时呼吸）

这些事件**不改变前景状态**，只是上报"有工具在跑"这个正交事实。

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `tool/call` | **工具/命令开始执行** | “在动手”，由独立的 tools 命令表达 |
| `tool-workflow/run-start` | workflow 编排开始 | 多智能体编排跑了 |
| `tool-workflow/agent-start` | workflow 里的子智能体启动 | |
| `command/run` | 斜杠命令开始执行 | |
| `compaction/start` | 上下文压缩开始 | 长对话时自动触发 |

对应地，以下事件在**最后一个**活动结束时上报 `tools off`：

| DSH 事件名 | 触发时机 | 配对主键 |
|---|---|---|
| `tool/result` | 工具执行结束（成功） | `data.message.source.callId` ↔ `tool/call` 的 `data.callId` |
| `tool-workflow/run-end` | workflow 结束 | `data.runId` |
| `tool-workflow/agent-end` | workflow 子智能体结束 | `data.runId` + `data.seq` |
| `command/done` | 斜杠命令结束 | `data.commandId` ↔ `command/run` 的 `data.commandId` |
| `compaction/end` | 上下文压缩结束 | `data.compactionId` ↔ `compaction/start` |
| `hook/result` | 钩子执行结束 | `data.hookId` ↔ `hook/invoked` |

> **必须按 ID 精确配对，不能用"计数器 +1/−1"。** 详见下一节 —— 这是真机踩出来的坑。

### ⚠️ 工具追踪为什么必须按 ID 配对（真机故障复盘）

**现象**：跑完一批工具后，绿灯一直呼吸不灭，用户以为"尾巴没生效"。

**根因**：早期版本 `#activeTools` 只是个计数器 —— `tool/call` 加一、`tool/result` 减一。
用真实会话日志（4233 个事件）回放后发现：

| 项 | 实测值 |
|---|---|
| `tool/call` 类事件 | 761 |
| `tool/result` 类事件 | **770**（比开工还多 9 个） |
| 回放后残留计数 | **1～2，永远回不到 0** |

多出来的原因是两类：
1. `command/done`、`hook/result` 被算作"收工"，但对应的 `command/run`、
   `hook/invoked` 早期**没有**被算作"开工"，单边减法；
2. 一轮结束时最后一个 `tool/call` 有时拿不到配对的 `tool/result`。

计数回不到 0，`#reportTools()` 就**永远不再发 `tools off`**，绿灯于是一直呼吸。

**修复（两道防线）**：

1. **按 ID 精确配对** —— 用 `Map<pair, Set<id>>` 记录还开着的主键，
   只有**配对得上**的收工事件才能移除；配不上的收工事件被安全忽略（计入
   `unmatchedEnds` 供排查），绝不动状态。
2. **轮次边界对账** —— 收到 `turn/start` / `turn/end` 时无条件清空所有残留。
   DSH 明确宣告"这一轮开始了/结束了"，上一轮的残留就已经没有意义。

**验证**：跨 12 个会话 / 78 个 `turn/end` / 8703 个事件回放，
**已结束轮次残留 = 0**。脚本：`scripts/verify-cross-session.mjs`。

> 注意「会话最后一个 turn 还没结束」时允许有残留 —— 那表示**工具真的在跑**，
> 绿灯此时呼吸是**正确行为**，不是故障。

### → `alarm`（黄灯快闪）

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `approval/asked` | **DSH 在等你批准权限** | 最重要的一盏灯：你不在电脑前也能看见 |

### → 解除 `alarm` → `thinking`

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `approval/decided` | 你已做出决定 | 灯回到黄灯呼吸 |

### → `success`（绿灯常亮）

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `turn/end` | **一轮对话结束** | “答完了” |

### → `error`（红灯常亮）

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `llm/retry` | 模型请求重试 | 通常是网络或服务端问题 |
| `llm/retry-started` | 重试已发起 | |

### → 结果类事件（按成败分流：失败进 `error`，否则回 `thinking`）

| DSH 事件名 | 触发时机 | 判定依据 |
|---|---|---|
| `tool/result` | 工具执行结束 | 载荷里带 `error` / `isError` / `failed` / `status=error` 判失败 |
| `tool-workflow/run-end` | workflow 结束 | 同上 |
| `tool-workflow/agent-end` | workflow 子智能体结束 | 同上 |
| `command/done` | 斜杠命令结束 | 同上 |
| `hook/result` | 钩子执行结束 | 同上 |

### → 计划模式与通知（4 个事件）

| DSH 事件名 | 载荷 | 灯效 |
|---|---|---|
| `plan/mode` | `{ active: true }` | 进入计划模式 → 🟢 绿灯常亮（背景修饰，不抢占黄/红） |
| `plan/mode` | `{ active: false }` | 退出计划模式 → 🟢 绿灯**快闪两下** → 回到当前前景状态 |
| `goal/change` | — | 🟢 绿灯**快闪两下** → **状态不变**（不动其他灯） |
| `sandbox/mode` | `{ mode, source? }` | 🟢 绿灯**快闪两下** → **状态不变** |

> `plan/mode` 的载荷结构确认自 `dsh-plan-mode/lib/index.js:374`
> （`session.append('plan/mode', { active })`），是「整体值」持续事件，有开有关。

### 特殊情形：计划模式下答完一轮

| 情形 | 灯效 |
|---|---|
| `turn/end` 且当时计划模式开着 | 🟢 绿灯**快闪两下** → 保持 🟢 绿灯常亮（`success+plan`） |
| `turn/end` 且不在计划模式 | 🟢 绿灯常亮（不闪） |

> 这个特例是为了不让「答完了」这个信号被计划模式的常亮绿灯吞掉。

### → `off`（全灭）

| DSH 事件名 | 触发时机 | 说明 |
|---|---|---|
| `session/end-seed` | 会话收尾 | 回到待机，**并同时清掉计划模式** |

---

## 三、刻意忽略的事件（按 Q6 决策：先只做 6 个核心状态）

这些事件**目前不点亮任何东西**。它们是“可以扩展”的候选，你想加就告诉我灯效。

### 子智能体相关（4）

| 事件名 | 含义 | 若要做，建议灯效 |
|---|---|---|
| `subagent/catalog` | 子智能体清单变化 | 蓝灯？需 RGB 灯 |
| `subagent/descriptor` | 子智能体描述变化 | 同上 |
| `subagent/model-selection-policy` | 子智能体选模型策略 | 一般不需要 |
| `agent-preset/selected` | 选定智能体预设 | 一般不需要 |

### 目标 / 待办 / 团队（5）

| 事件名 | 含义 | 当前处理 |
|---|---|---|
| `goal/change` | 目标状态变化 | ✅ **已实现 → 绿灯快闪两下** |
| `todo/write` | 待办列表更新 | 忽略 |
| `team/member` | 团队成员变化 | 忽略（多智能体场景） |
| `team/message/queued` | 团队消息入队 | 忽略 |
| `team/message/delivered` | 团队消息送达 | 忽略 |

### 审批 / 权限 / 沙箱 / 计划（6）

| 事件名 | 含义 | 当前处理 |
|---|---|---|
| `approval/asked` | 等你批准 | ✅ **已实现 → alarm** |
| `approval/decided` | 你已决定 | ✅ **已实现 → thinking** |
| `approval/policy` | 审批策略变化 | 忽略 |
| `permission/preset` | 权限预设变化 | 忽略 |
| `sandbox/mode` | 沙箱模式变化 | ✅ **已实现 → 绿灯快闪两下** |
| `plan/mode` | 计划模式开关 | ✅ **已实现 → 绿灯常亮背景 / 退出闪两下** |

### 会话 / 模型 / 请求（7）

| 事件名 | 含义 |
|---|---|
| `session/title` | 会话标题生成 |
| `session/title-llm-request` | 为标题发起的模型请求 |
| `model/selection` | 模型切换 |
| `request/header` | 模型请求头记录 |
| `request/context` | 请求上下文 |
| `session-log-deepseek/delivery-accepted` | 日志投递确认 |
| `web/deepseek-search-llm-request` | 搜索用的模型请求 |

### 消息 / 反馈 / 投递（6）

| 事件名 | 含义 |
|---|---|
| `user/message` | 用户消息落库 |
| `system/message` | 系统消息 |
| `assistant/attempt` | ✅ **已实现 → thinking** |
| `assistant/message` | ✅ **已实现 → thinking** |
| `feedback/message-put` `feedback/message-delete` `feedback/record` | 消息反馈 |
| `deliverables/presented` | 交付物呈现 |

### 钩子 / 调度 / 其他（9）

| 事件名 | 含义 | 当前处理 |
|---|---|---|
| `hook/invoked` | 钩子被调用 | 忽略 |
| `hook/result` | 钩子结果 | ✅ **已实现（结果类）** |
| `schedule/change` | 定时任务变化 | 忽略 |
| `agent/inbox/spliced` | 收件箱拼接 | 忽略 |
| `tool/ptc-dispatch` `tool/ptc-dispatch-start` | 工具派发 | 忽略 |
| `compaction/end` `compaction/prune` `compaction/summary` | 压缩结束/裁剪/摘要 | 忽略（`compaction/start` 已处理） |

---

## 四、统计

| 项 | 数量 |
|---|---|
| DSH 已知事件类型总数 | **56** |
| 插件当前识别并映射 | **23** |
| 其中 → thinking | 5 |
| 其中 → 工具「开工」（上报 `tools on`） | 6 |
| 其中 → 工具「收工」（配对后上报 `tools off`） | 6 |
| 其中 → alarm | 1 |
| 其中解除 alarm | 1 |
| 其中 → success | 1 |
| 其中 → error | 2 |
| 其中 → off | 1 |
| 其中计划模式开关 | 1 |
| 其中只闪不改状态 | 2（`goal/change`、`sandbox/mode`） |
| 刻意忽略 | 33 |

> 「开工/收工」是**成对**的，由插件里的 `ID_PAIRS` 表统一声明，
> `RESULT_EVENTS` 直接从这张表推导，避免手写两份集合时间一长就不一致。

---

## 五、两个安全兜底（防止灯卡住）

| 兜底 | 默认值 | 实现位置 | 作用 |
|---|---|---|---|
| `alarm` 超时回落 | **60 秒** | **插件**（`alarmTimeoutMs`） | 你关掉弹窗后没人处理，灯自动回到之前的状态 |
| 空闲自动全灭 | **5 分钟** | **固件**（`STALE_TIMEOUT_MS`） | 电脑异常退出/DSH 崩溃后，灯不会一直亮着 |

> ⚠️ **两个兜底的归属不同，所以改法也不同。** 别在插件里找空闲超时 —— 那里没有。

`alarm` 回落是**插件**的，可以在 `~/.dsh/profiles/web/cordis.patch.yml` 里改：

```yaml
- id: dsh-led-bridge
  config:
    alarmTimeoutMs: 30000   # 改成 30 秒
```

**空闲自动灭灯是固件独占的**，要改就改
`firmware/esp32c3_dsh_status_light/esp32c3_dsh_status_light.ino` 里的
`STALE_TIMEOUT_MS` 并**重烧固件**。

> **为什么它不该在插件里**：插件曾经也有一个 `idleTimeoutMs`，与固件那份是同一件事的
> 两份实现，结果是「旋钮是假的」（固件无条件生效，设 0 或调大都无效）+「语义打架」
> （插件测「多久没有新状态」，固件测「多久没有串口活动」，长推理会被插件误灭灯）。
> 已删除。`scripts/audit-boundaries.mjs` 有两条断言盯着这件事：
> 插件里不许再出现 idle 相关标识符，同时固件必须真的持有并按它执行。

---

## 六、想加新状态时怎么做

1. 从上文“刻意忽略”的表里挑一个事件名；
2. 告诉我**你希望它显示成什么样**（哪个颜色、常亮/慢闪/快闪/呼吸，要不要用 `notify`）；
3. 我改三处：`plugin/lib/index.js` 的映射表（若涉及组合还要动状态机）、
   （若需要新灯效）`firmware/.../esp32c3_dsh_status_light.ino` 的灯效函数、
   以及 `scripts/selftest.mjs` 里加一条回归测试；
4. 跑 `node scripts/verify-all.mjs`（含 selftest / simulate / 协议 / 架构四组）
   确认映射不冲突，再 `scripts/build.ps1` 编译。

### 排查工具（本次故障复盘用的，留给你以后自查）

| 脚本 | 用途 |
|---|---|
| `scripts/probe-events.mjs` | 解压最近会话日志，统计事件类型与工具配对情况 |
| `scripts/probe-callid.mjs` | 确认 `callId` 的嵌套路径，逐 turn 核对配对 |
| `scripts/probe-event-shapes.mjs` | 普查每种事件的 data 结构与主键 |
| `scripts/replay-session.mjs` | 把真实会话事件灌进插件，打印它发出的每条串口命令 |
| `scripts/compare-old-new.mjs` | 旧盲计数 vs 新 ID 配对的对照实验 |
| `scripts/verify-cross-session.mjs` | 跨会话核对：已结束轮次是否都归零 |
| `scripts/zstd-frames.mjs` | DSH 会话日志是**多帧 zstd**，这个解码器供上面几个脚本复用 |

> 注意：DSH 的 `session.v3.jsonl.zstd` 是「每行一个独立 zstd 帧」拼接的，
> `zlib.zstdDecompressSync` 只能解第一帧，必须按 magic 切分后逐帧解压。

**信息容量提醒**：玩具红绿灯只有 3 个颜色，但**可以组合**（因为三颗灯珠物理独立）。
所以理论组合数是 2³ = 8 种「亮/灭」形态，再乘以每种灯的不同节奏（常亮/慢闪/快闪/呼吸），
容量比"只有 3 个颜色"大得多。但如果以后要表达**十几个以上**互不重叠的状态，
建议升级成 **WS2812 彩灯**（你商家资料里那个 `WS2812 ESP32C3.py` 就是干这个的），
颜色和亮度都能自由编码，信息容量会再上一个数量级。

