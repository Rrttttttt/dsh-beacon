# dsh-led-bridge

把 DeepSeek Harness 的实时工作状态**广播**出去。

## 它本来要解决什么

DSH 在终端里跑。你盯着屏幕的时候，一眼就知道它是在想、在跑工具、还是卡在权限确认上。

但你一离开屏幕 —— 去倒水、去开会、切到别的窗口 —— 这些信息就没了。它还在跑吗？
还是早就停下来等你了？终端不会告诉你，因为**状态只存在于那一个窗口里**。

这个插件把 DSH 的工作状态变成一条可以被外部读取的信号，让"它现在在干什么"这件事
不再依赖你盯着某一个屏幕。

## 它只上报事实，不做渲染决定

| 它做 | 它不做 |
|---|---|
| 发 `thinking`、`error`、`tools on` 这类**状态命令** | 决定灯怎么亮、亮多久 |
| 告诉接收端"发生了什么" | 决定呼吸多快、闪几下、什么时候熄 |
| 设备掉线后自己等待重连 | 假设接收端一定是一盏灯 |

所以插件里**没有任何灯效时长参数**。同一个插件可以驱动完全不同的输出端，因为它们
各自决定怎么把事实表现出来。

## 输出端可以是任何东西

协议就是**一行纯文本**。任何能读串口的设备或程序都能当输出端：

| 输出端 | 例子 |
|---|---|
| 桌面状态灯 | 我们自己的第一个接收端：一盏三色交通灯（ESP32-C3 + 红/黄/绿三颗 LED） |
| 灯带 / 氛围灯 | WS2812、任何可编程灯 |
| 其它开发板 | Arduino、Raspberry Pi Pico、任何带 USB 串口的单片机 |
| 电脑上的小程序 | 托盘图标、系统通知、OBS 叠加层、第二块屏上的状态条 |
| 纯软件 | 一个 `while read line` 的 shell 脚本也算 |

上面那盏交通灯只是**第一个**接收端，不是这个插件的边界。仓库 `dsh-beacon` 会承载
在此基础上扩展的多元输出版本。

## 发送的命令

| 命令 | 含义 |
|---|---|
| `off` | 待机 |
| `thinking` | 模型正在生成 |
| `success` | 一轮答完 |
| `error` | 出错 / 模型重试 |
| `alarm` | 等你批准权限（最高优先级） |
| `tools on` / `tools off` | 有 / 没有工具在执行（独立事实，不改前景状态） |
| `notify [状态]` | 一个"该看一眼了"的提示：接收端可以用任何方式表现它（闪一下、响一声、弹个通知）；不写状态则提示完回到之前的状态 |
| `<状态>+plan` | 计划模式背景修饰，可与任一前景状态组合 |

`alarm` 的回落时间由 `alarmTimeoutMs` 控制（默认 60 秒；`0` = 永不回落）。

接收端回 `READY` 表示握手完成，回 `OK <cmd>` / `ERR <text>` 表示执行结果。
插件不要求接收端必须回执：不回也能用，只是看不到确认。

## 安装

```sh
dsh plugin --profile web add "link:<本目录绝对路径>"
dsh --profile web --dump-config   # 验证：应能看到一层 dsh-led-bridge
```

插件依赖 `serialport`。安装时 pnpm ≥ 10 会拦截 `@serialport/bindings-cpp` 的构建脚本
并以退出码 1 结束；而 `dsh plugin` 只在 pnpm 退出码为 0 时才登记插件，于是会**装上了
却没被加进 `dsh.profile.bundles`**。此时在 profile 的 `pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  '@serialport/bindings-cpp': true
```

装完**必须重启 DSH**：插件配置只在进程启动时读一次。

> **路径含空格时先换个位置。** `dsh plugin` 在 Windows 上用 `shell:true` 起 pnpm，
> 会丢掉参数引号：带空格的 spec 被拆成多个参数，pnpm 转而去 registry 找一个不存在的包，
> 以 404 失败。所以先把目录拷到不含空格的路径再 `link:`，例如：
>
> ```sh
> robocopy "<本目录>" "%USERPROFILE%\.dsh\plugins\dsh-led-bridge" /E
> dsh plugin --profile web add "link:%USERPROFILE%/.dsh/plugins/dsh-led-bridge"
> ```
>
> 拷副本而不是原地引用还有第二个好处：每个 profile 各有一份，装机测试不会互相覆盖。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id` 覆盖（`config` 是整体替换，要保留的键一起写上）：

```yaml
- id: dsh-led-bridge
  config:
    port: COM7                # 跳过自动发现；空串 = 自动
    vendorId: '303a'          # 接收端的 USB 厂商号
    productId: '1001'         # 接收端的 USB 产品号
    baudRate: 115200
    alarmTimeoutMs: 60000     # alarm 超时回落（毫秒）；0 = 永不回落
    reconnectIntervalMs: 5000 # 找不到设备时的重试间隔
```

## 串口自动发现

不写死端口号。按 USB VID/PID 匹配；macOS 上部分平台拿不到 VID/PID，退回按设备名
匹配 `usbmodem|usbserial|ttyACM|ttyUSB`。找不到设备时按 `reconnectIntervalMs` 重试；
设备拔掉后自动等待重新接入，不需要重启 DSH。

换成别的接收端时，把 `vendorId` / `productId` 改成它自己的，或者直接用 `port` 写死。

## 事件 → 状态

| 事件 | 动作 |
|---|---|
| `step/start` `step/end` `assistant/attempt` `assistant/message` `turn/start` | `thinking` |
| `tool/call` `tool-workflow/run-start` `tool-workflow/agent-start` `command/run` `compaction/start` | `tools on` |
| 上述开工事件**配对得上**的收工事件 | `tools off`（配不上则忽略，绝不动计数） |
| `turn/start` `turn/end` | 无条件清空活动记录（丢掉跨轮残留） |
| `turn/end` | `success`（计划模式开着时：`notify success+plan`） |
| `llm/retry` `llm/retry-started` | `error` |
| 配对收工事件里带错误标记 | `error` |
| `approval/asked` | `alarm`（最高优先级，期间其他事件不夺权） |
| `approval/decided` | 回到 `thinking` |
| `plan/mode {active:true}` | 进入计划模式：当前状态加 `+plan` 修饰 |
| `plan/mode {active:false}` | 退出：`notify <当前状态>`，提示后回到前景状态 |
| `goal/change` `sandbox/mode` | 只 `notify`，不改状态 |
| `session/end-seed` | `off`（并清掉计划模式） |

事件名取自 `@deepseek-ai/dsh-session` 的 `known-event-types`。子智能体、多会话、
`todo/write`、`team/*` 等按约定刻意忽略。

工具追踪按 ID 精确配对而不是盲计数：只有配对得上的收工事件才能移除记录，配不上的
安全忽略。早期版本用加减计数，真机上收工事件比开工事件多，计数永远回不到 0，
于是插件再也不发 `tools off`。

## 卸载

```sh
dsh plugin --profile web remove dsh-led-bridge
```

## License

MIT
