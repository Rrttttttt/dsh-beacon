# dsh-led-bridge

把 **DeepSeek Harness 的工作状态**通过 USB 串口实时推送到 ESP32-C3 红绿灯摆件。

> **这是试验版桥梁。** 它只做一件事：把 DSH 状态推给 ESP32-C3。
> 仓库 [dsh-beacon](https://github.com/Rrttttttt/dsh-beacon) 的最终形态
> **`dsh-beacon`** 会把这里的能力并进来，再加上系统托盘图标、桌面悬浮球、
> Windows 通知、余额/消耗显示 —— 届时本插件会成为它的一个 sink。

硬件接线、固件烧录、完整排错请看 [仓库根目录的 README](../README.md)。

## 它做什么

跑在 DSH 进程内部，订阅 `session/event`（DSH 原生全量会话事件流），把事件归约成
两类**事实**并往串口写命令。

> ### ⚠️ 架构约定：本插件只报告事实，不做任何灯效决定
>
> **插件的职责边界**：
> - ✅ 报告**前景状态**（thinking / error / alarm / success / off）
> - ✅ 报告**计划模式开关**（`+plan` 修饰）
> - ✅ 报告**有无工具在跑**（`tools on` / `tools off`）
> - ❌ **不决定**黄灯该呼吸还是绿灯该呼吸
> - ❌ **不决定**绿灯什么时候熄灭（呼吸尾巴在固件里）
> - ❌ **不持有**任何灯效时长参数
>
> 想调整观感（呼吸快慢、工具尾巴长短）→ 改固件常量并重烧，**不需要动插件**。
> 有两条回归测试在守着这条边界：`selftest.mjs` 与 `simulate.mjs` 各有一条
> 「插件配置里没有任何灯效时长参数」的断言。

### 命令一览

| 命令 | 含义 | 渲染出的灯效（由固件决定） |
|---|---|---|
| `thinking` | 模型正在生成 | 🟡 黄灯呼吸 |
| `tools on` | **有工具在执行**（独立命令） | 🟡 黄灯呼吸 **+** 🟢 绿灯同时呼吸（相位错开） |
| `tools off` | 工具全部结束 | 绿灯**不立即灭** —— 固件走完一个完整呼吸周期才熄灭 |
| `alarm` | 等你批准权限 | 🟡 黄灯快闪 |
| `error` | 出错 / 模型重试 | 🔴 红灯常亮 |
| `success` | 一轮答完 | 🟢 绿灯常亮 |
| `off` | 待机 | ⚫ 全灭 |
| `plan` | 计划模式（前景为 off 时） | 🟢 绿灯常亮 |
| `thinking+plan` 等 | 前景 + 计划模式背景 | 前景灯效 **+** 🟢 绿灯常亮 |
| `notify [state]` | 绿灯快闪两下（0.15s×2） | 闪完切到 `state`，不写则回到闪前状态 |

**为什么工具是独立命令而不是状态名修饰符**：一轮里的事件流是
`tool/call → tool/result → assistant/message(thinking) → tool/call → …`。
若把「在跑工具」编码进状态名，每一步都会在两种状态间来回切，观感是**黄绿频闪**。
独立命令 + 固件侧持有状态，就完全没有这个问题。

动画在板子上跑，所以**串口平时完全静默**，只有事件发生时才有一个短包。

## 线协议

| 方向 | 内容 |
|---|---|
| 电脑 → 板子 | `<state>[\n]`，state ∈ `off` `thinking` `error` `alarm` `success` `plan`，以及 `+plan` 组合形式 |
| 电脑 → 板子 | `tools on` / `tools off` —— 工具执行状态（**与前景状态正交的独立事实**） |
| 电脑 → 板子 | `notify [state]` —— 绿灯快闪两下，闪完切到 `state`（不写则回到闪烁前状态） |
| 板子 → 电脑 | `ESP32_STATUS_LIGHT READY`（上电握手，插件靠它确认板子在） |
| 板子 → 电脑 | `OK <cmd>`（执行回执） / `ERR unknown <text>` |


## 为什么需要插件

DSH 的工作状态只存在于 DSH 进程内部，且默认不对外输出：

- 会话日志是 `zstd` 压缩，而且**整轮不落盘**（只在轮次结束时整体重写），无法实时 tail；
- Web 服务（`127.0.0.1:3080`）有信任边界，不带凭据一律 `401`，真正的通道是内部私有协议
  `/api/remote.mux`，逆向它 DSH 一升级就废；
- Claude Code / Codex 兼容钩子只支持 7 个事件，**拿不到 `approval/asked`**，
  也就是说 `alarm`（黄灯快闪）永远不会亮。

原生插件是唯一能拿全 6 个状态的方式。

## 安装

### 推荐：自包含包（零配置）

从 [Releases](https://github.com/Rrttttttt/dsh-beacon/releases) 下 `dsh-led-bridge-<版本>.zip`，
解压后跑 `install.ps1`。它自带运行时依赖，**不需要改任何配置文件**。

### 从源码

```sh
dsh plugin --profile web add "link:<本目录绝对路径>"

# 装完验证：应能看到一层 dsh-led-bridge
dsh --profile web --dump-config
```

这种方式**需要手工加一项 `allowBuilds`**（源码没自带依赖树），见下一节。

其它分发方式与各自的授权差异，见 [../docs/DISTRIBUTION.md](../docs/DISTRIBUTION.md)。

## 依赖说明（必读）

依赖 `serialport`，它间接依赖 **`@serialport/bindings-cpp`**，后者声明了 install 脚本。

> ⚠️ **注意是 `@serialport/bindings-cpp`，不是 `serialport` 本身。**
> 这是实测踩出来的：授权错包名不起作用。

### 为什么必须授权（否则安装会静默失败）

pnpm ≥ 10 默认拒绝执行依赖的构建脚本，然后 **退出码为 1**（`ERR_PNPM_IGNORED_BUILDS`）。
而 `dsh plugin` 只在 pnpm 退出码为 0 时才登记插件：

```js
const exitCode = result.status ?? 1;
if (exitCode === 0) reconcilePlugins(before, dir);   // ← 非 0 就跳过
```

结果：**依赖装好了、但插件从未被加进 `dsh.profile.bundles`**，看起来"安装失败"。
**这与安装来源无关** —— npm、tarball、`link:` 本地路径、git 全都会踩到。
对照实验验证过：不加这项 pnpm 退出码 1，加了退出码 0。

### 解法

在该 profile 的 `pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  '@serialport/bindings-cpp': true
```

> 这一项**无法全局设置** —— pnpm 会拒绝
> `pnpm config set allowBuilds … --global`（`ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY`），
> 只能逐台机器手工加。**这正是自包含包存在的原因**：它把依赖树直接发给你，
> pnpm 只需装 1 个包就退出 0，于是那一项完全不需要。

手动装的话自己加，然后重新执行 `dsh plugin --profile web add ...`。

> 这项授权允许包代码在**安装时**于你机器上执行，请只对自己信任的仓库这么做。
>
> 补充事实：`serialport` 的预编译 `.node` 绑定是**随包一起发的**（实测解压后有 13 个平台变体），
> 所以这个 install 脚本只是"从源码重新编译"的可选路径。加授权的**唯一目的**是让 pnpm 干净退出，
> 好让 `dsh plugin` 愿意登记插件。

## 配置

在 `~/.dsh/profiles/web/cordis.patch.yml` 里按 `id` 覆盖（改插件行的 `config` 会替换整个值，
所以要把想保留的键一起写上）：

```yaml
- id: dsh-led-bridge
  config:
    port: COM7                # 跳过自动发现；空串 = 自动
    vendorId: '303a'          # Espressif 的 USB 厂商号
    productId: '1001'         # ESP32-C3 原生 USB-Serial/JTAG
    baudRate: 115200
    alarmTimeoutMs: 60000     # alarm 超时回落（毫秒）；0 = 永不回落
    idleTimeoutMs: 300000     # 空闲自动全灭（毫秒）；0 = 不自动灭
    reconnectIntervalMs: 5000 # 找不到板子时的重试间隔
```

## 串口自动发现

不写死 COM 号（换电脑 COM 号一定会变）。按 USB VID/PID 匹配：

- Windows / Linux：`vendorId = 303a` 且 `productId = 1001`
- macOS：部分平台拿不到 VID/PID，退回按设备名匹配 `usbmodem|usbserial|ttyACM|ttyUSB`

找不到板子时每 5 秒重试；板子拔掉后自动等待重新插入，不需要重启 DSH。

## 事件 → 状态 完整映射

| 事件 | 状态 |
|---|---|
| `step/start` `step/end` `assistant/attempt` `assistant/message` `turn/start` | thinking |
| `tool/call` `tool-workflow/run-start` `tool-workflow/agent-start` `command/run` `compaction/start` | `tools on`（独立命令，不改前景） |
| `approval/asked` | alarm |
| `approval/decided` | thinking |
| `turn/end` | success（计划模式开着时：`notify success+plan`，闪两下再常亮） |
| `llm/retry` `llm/retry-started` | error |
| `tool/result` 等**配对得上**的收工事件里带错误标记 | error |
| `plan/mode` `{active:true}` | 进入计划模式：绿灯常亮（对当前状态加 `+plan` 修饰） |
| `plan/mode` `{active:false}` | 退出：`notify <当前状态>`，绿灯闪两下后回到前景状态 |
| `goal/change` | `notify`（闪两下，状态不变） |
| `sandbox/mode` | `notify`（闪两下，状态不变） |
| `session/end-seed` | off（并清掉计划模式） |

事件名取自 `@deepseek-ai/dsh-session` 的 `known-event-types`（本机实测 56 种）。
子智能体、多会话、`todo/write`、`team/*` 等按约定刻意忽略。
完整逐条表见 [../docs/DSH事件与灯状态对应表.md](../docs/DSH事件与灯状态对应表.md)。

`alarm` 具有最高优先级：在等用户确认期间，其他事件不会把灯顶掉。

### 工具追踪为什么必须按 ID 配对（真机故障复盘）

早期版本用**盲计数器**统计工具：`tool/call` 加一、`tool/result` 减一。
真机症状是**绿灯一直呼吸不灭**。解压真实会话日志（4233 个事件）回放后拿到硬数据：

```
tool/call  类事件:  761
tool/result 类事件: 770     ← 比"开工"还多 9 个
回放后残留计数:      1～2    ← 永远回不到 0
```

计数回不到 0，插件**永远不再发 `tools off`**，固件收不到结束信号，绿灯就一直呼吸。
多出来的原因是两类：`command/done`、`hook/result` 被算作"收工"而对应的开工事件没被算作"开工"
（单边减法）；以及一轮结束时最后一个 `tool/call` 有时等不到配对的 `tool/result`。

**修复（两道防线）**：

1. **按 ID 精确配对** —— `ID_PAIRS` 表声明每对事件的主键
   （`tool/call`↔`tool/result` 用 `callId`、`command/*` 用 `commandId` 等，
   字段名取自 `SessionEventMap` 类型定义）。只有**配对得上**的收工事件才能移除记录；
   配不上的被安全忽略并计数备查，绝不动状态。
2. **轮次边界对账** —— `turn/start` / `turn/end` 时无条件清空残留。

**验证**：12 个会话 / 78 个 `turn/end` / 8703 个事件回放，**已结束轮次残留 = 0**。

> 注意：**该轮还没结束时绿灯呼吸是正确行为**（工具真的在跑），
> 只有**已结束的轮次**还有残留才是 bug。

## 实现上的两个易踩坑（已用回归测试守住）

1. **`off` 必须与清计划模式一起强制下发。** 如果先 `set(off)` 再改 plan 标志，
   状态去重逻辑会把下发整个吞掉，板子会永远停在上一个状态。
   见 `selftest.mjs` 里 `session/end-seed 会同时清掉计划模式`。
2. **`base` 为 `off` 时不能发 `off+plan`。** 固件不认这个命令。
   现在 `current` 会把它归一成 `plan`。见 `进入计划模式：绿灯常亮`。


## License

MIT
