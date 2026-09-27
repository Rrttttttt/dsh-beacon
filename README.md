# dsh-beacon

把 DeepSeek Harness 的工作状态，变成一盏抬头就能看见的灯。

这个仓库是完整的两半，缺一不可：

| | 目录 | 干什么 |
|---|---|---|
| **插件** | `lib/` | 监听 DSH 会话事件，把状态压成**一行文本**发出去 |
| **固件** | `firmware/esp32c3_dsh_status_light/` | ESP32-C3 收到那行文本，点亮红 / 黄 / 绿三色灯 |

---

## 为什么要有它

DSH 在终端里跑。你盯着屏幕时，一眼就知道它是在想、在跑工具、还是卡在权限确认上。

但你一离开屏幕 —— 去倒水、去开会、切到别的窗口 —— 这些信息就没了。它还在跑吗？还是早就停下来等你了？终端不会告诉你，因为**状态只存在于那一个窗口里**。

这盏灯把"它现在在干什么"挪到一个不需要盯着看的地方。余光扫一眼就够。

### 插件只上报事实，不做渲染决定

| 它做 | 它不做 |
|---|---|
| 发 `thinking`、`error`、`alarm` 这类**状态命令** | 决定灯怎么亮、亮多久 |
| 告诉接收端"发生了什么" | 决定呼吸多快、闪几下、什么时候熄 |
| 设备掉线后自动重连 | 假设接收端一定是一盏灯 |

所以插件里**没有任何灯效时长参数**。协议就是一行纯文本，任何能读串口或 TCP 的东西都能当接收端：WS2812 灯带、第二块屏上的状态条、托盘图标、OBS 叠加层，或者一个 `while read line` 的 shell 脚本。

`firmware/` 里的三色灯只是**第一个**接收端，不是这个插件的边界。

---

## 灯效

| 命令 | 黄 | 绿 | 红 |
|---|---|---|---|
| `off` | — | — | — |
| `thinking` | 呼吸（2.4s 周期） | — | — |
| `thinking` + 工具在跑 | 呼吸 | 微亮 | — |
| `busy` ※ | — | 慢闪 | — |
| `error` | — | — | 常亮 |
| `alarm` | 快闪 | — | — |
| `success` | — | 常亮 | — |
| `plan` | — | 常亮 | — |
| `<状态>+plan` | 同 `<状态>` | 常亮 | — |
| `notify` / `notify <状态>` | — | 快闪 2 下 | — |
| 配网模式（无 WiFi） | — | — | 慢闪 |

`notify` 是"该看一眼了"的提示：闪完回到闪烁前的状态；写成 `notify success` 则闪完**落到** `success`。

`alarm`（等你批准权限）优先级最高，期间其他事件不夺权，默认 60 秒后回落。

> ※ `busy` 固件认，但**内置插件不发它** —— 状态机里没有哪个事件映射到 `busy`。留着是给别的发送端（自己写的脚本、别的 agent）用的。

---

## 硬件

| 件 | 说明 |
|---|---|
| 主控 | ESP32-C3-MINI-1（任何 ESP32-C3 开发板都行） |
| 灯 | 三色 LED 模块，**共阳**（公共端接 `3V3`，低电平点亮） |
| 模式开关 | 一只单刀开关，接在 `GPIO4` 和 `GND` 之间 |

| 信号 | 引脚 |
|---|---|
| 红 | `GPIO5` |
| 黄 | `GPIO6` |
| 绿 | `GPIO7` |
| 模式开关 | `GPIO4` ↔ `GND` |
| 灯公共端 | `3V3` |

> **共阴模块也能用**：把固件里的 `ACTIVE_LOW` 改成 `false`，公共端接 `GND`。

### 模式开关

**有线还是无线，只看 `GPIO4` 上这只开关，设备不做任何自动猜测。**

| 开关 | 模式 | 行为 |
|---|---|---|
| **断开**（悬空，内部上拉） | 有线 | 走 USB 串口，**WiFi 完全关闭** |
| **闭合**（接 `GND`） | 无线 | 连 WiFi，开 TCP + UDP 监听 `8234` |

运行中拨动开关，板子会**自动重启**并切到对应模式，不需要手动按 RST。

---

## 快速开始

### 1. 烧固件

Arduino IDE 装好 esp32 支持后，打开 `firmware/esp32c3_dsh_status_light/`，开发板选 **ESP32C3 Dev Module**。

用 `arduino-cli` 的话：

```sh
arduino-cli compile --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc,FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,CPUFreq=80" firmware/esp32c3_dsh_status_light
arduino-cli upload  --fqbn "esp32:esp32:esp32c3:CDCOnBoot=cdc,FlashMode=dio,FlashFreq=40,FlashSize=4M,PartitionScheme=default,CPUFreq=80" -p <端口> firmware/esp32c3_dsh_status_light
```

`CDCOnBoot=cdc` **不能省** —— 少了它串口不会通过 USB 枚举出来。

上电后灯会自检一遍（红→黄→绿），串口打印一行握手：

```
ESP32_STATUS_LIGHT READY fw=1.0.0 via=boot reset=...
```

### 2. 装插件

```sh
dsh plugin --profile web add "link:<本目录绝对路径>"
dsh --profile web --dump-config   # 验证：应能看到一层 dsh-led-bridge
```

装完**必须重启 DSH**：插件配置只在进程启动时读一次。

#### 两个已经踩过的坑

**一、pnpm ≥ 10 会拦构建脚本。** 插件依赖 `serialport`，安装时 pnpm 会拦截 `@serialport/bindings-cpp` 的构建脚本并以退出码 1 结束；而 `dsh plugin` 只在 pnpm 退出码为 0 时才登记插件 —— 于是会**装上了却没被加进 `dsh.profile.bundles`**。此时在 profile 的 `pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  '@serialport/bindings-cpp': true
```

**二、路径含空格会装不上。** `dsh plugin` 在 Windows 上用 `shell:true` 起 pnpm，会丢掉参数引号：带空格的 spec 被拆成多个参数，pnpm 转而去 registry 找一个不存在的包，以 404 失败。先把目录拷到不含空格的路径再 `link:`：

```powershell
robocopy "<本目录>" "$env:USERPROFILE\.dsh\plugins\dsh-led-bridge" /E
dsh plugin --profile web add "link:$env:USERPROFILE/.dsh/plugins/dsh-led-bridge"
```

拷副本而不是原地引用还有第二个好处：每个 profile 各有一份，装机测试不会互相覆盖。

### 3. 接上

**有线**：插 USB，插件会按 `VID 303a` / `PID 1001` 自动找到串口，不需要配端口号。

**无线**：把模式开关拨到闭合，重启后板子连 WiFi，串口会打印它的 IP：

```
WiFi 已连接，IP：192.168.1.42
监听 TCP 8234
```

把 IP 填进插件配置的 `host`：

```yaml
- id: dsh-led-bridge
  config:
    host: 192.168.1.42
```

> 插件**不做** UDP / mDNS 发现 —— 无线模式要自己去串口读一次 IP。DHCP 换 IP 后同样要改。

#### 第一次联网：配网页面

无线模式下板子如果**没有存过凭据**、或者**连不上**，会自己开一个热点：

```
DSH-Beacon-3F2A      ← 后四位是芯片 MAC
```

连上它，浏览器会**自动跳出配网页**（做了 DNS 劫持，任何域名都指回板子）。页面上能扫描附近 WiFi、填密码、保存并重启，也能看到板子的启动次数和上次复位原因。

也可以在**串口**里直接配，不用开热点：

```
wifi <SSID> <密码>
wifi clear          # 清掉凭据，下次开机进配网
```

---

## 通信协议

**一行一条命令，行尾 `\n`。** 插件 → 设备：

| 命令 | 含义 |
|---|---|
| `off` | 待机 |
| `thinking` | 模型正在生成 |
| `busy` | 慢闪。**固件认，内置插件不发** —— 留给自己写的发送端 |
| `success` | 一轮答完 |
| `error` | 出错 / 模型重试 |
| `alarm` | 等你批准权限（最高优先级） |
| `tools on` / `tools off` | 有 / 没有工具在执行（独立事实，不改前景状态） |
| `notify [状态]` | "该看一眼了"的提示；不写状态则闪完回到之前的状态 |
| `<状态>+plan` | 计划模式修饰，可与任一前景状态组合 |

同义写法固件也认：`idle`→`off`、`think`→`thinking`、`fail`→`error`、`wait`→`alarm`、`done`→`success`。

**设备 → 插件**：

```
ESP32_STATUS_LIGHT READY fw=1.0.0 via=boot reset=USB 外设复位(11)   ← 握手
OK thinking                                                         ← 执行成功
ERR unknown blabla                                                  ← 不认识这条命令
```

插件不要求接收端必须回执：不回也能用，只是看不到确认。

### 固件自带的诊断命令

这些**不属于插件协议**，是给你调试用的：

| 命令 | 作用 |
|---|---|
| `state?` | 回两行当前内部状态与三颗灯的效果名 |
| `wifi?` | 回 WiFi 状态、IP、监听端口 |
| `mode` | 回当前是有线还是无线 |
| `power` | 回 / 设发射功率等板级参数 |
| `wifi <ssid> <pass>` | 保存凭据并重启 |

无线模式下，`8234` 端口**同时**接受 TCP 长连接和 UDP 单包，两者都能下命令。

**5 分钟没有收到任何命令，灯自动回到 `off`。** 以免 DSH 崩了之后灯还僵在 `thinking` 上骗你。

---

## 插件配置

在 profile 的 `cordis.patch.yml` 里按 `id` 覆盖（**`config` 是整体替换**，要保留的键一起写上）：

```yaml
- id: dsh-led-bridge
  config:
    host: ''                  # 非空 = 走 TCP，空 = 走串口
    tcpPort: 8234             # 无线模式下板子监听的端口
    port: ''                  # 跳过自动发现，直接写死串口，如 COM7
    vendorId: '303a'          # 接收端的 USB 厂商号
    productId: '1001'         # 接收端的 USB 产品号
    baudRate: 115200
    alarmTimeoutMs: 60000     # alarm 超时回落（毫秒）；0 = 永不回落
    reconnectIntervalMs: 5000 # 找不到设备时的重试间隔
```

不写死端口号。按 USB VID/PID 匹配；macOS 上部分平台拿不到 VID/PID，退回按设备名匹配 `usbmodem|usbserial|ttyACM|ttyUSB`。设备拔掉后自动等待重新接入，不需要重启 DSH。

换成别的接收端时，把 `vendorId` / `productId` 改成它自己的，或者直接用 `port` 写死。

---

## 事件 → 状态

| DSH 事件 | 动作 |
|---|---|
| `step/start` `step/end` `assistant/attempt` `assistant/message` `turn/start` | `thinking` |
| `tool/call` `tool-workflow/run-start` `tool-workflow/agent-start` `command/run` `compaction/start` `hook/invoked` | `tools on` |
| 上述开工事件**配对得上**的收工事件 | `tools off`（配不上则忽略，绝不动计数） |
| `turn/start` `turn/end` | 无条件清空活动记录（丢掉跨轮残留） |
| `turn/end` | `success`（计划模式开着时：`notify success+plan`） |
| `llm/retry` `llm/retry-started` | `error` |
| 配对收工事件里带错误标记 | `error` |
| `approval/asked` | `alarm`（最高优先级，期间其他事件不夺权） |
| `approval/decided` | 回到 `thinking` |
| `plan/mode {active:true}` | 当前状态加 `+plan` 修饰 |
| `plan/mode {active:false}` | `notify <当前状态>`，提示后回到前景状态 |
| `goal/change` `sandbox/mode` | 只 `notify`，不改状态 |
| `session/end-seed` | `off`（并清掉计划模式） |

事件名取自 `@deepseek-ai/dsh-session` 的 `known-event-types`。子智能体、多会话、`todo/write`、`team/*` 等按约定刻意忽略。

工具追踪按 ID **精确配对**而不是盲计数：只有配对得上的收工事件才能移除记录，配不上的安全忽略。早期版本用加减计数，真机上收工事件比开工事件多，计数永远回不到 0，于是插件再也不发 `tools off`。

---

## 故障排查

| 现象 | 先看这里 |
|---|---|
| 插上 USB 但没有串口 | FQBN 里漏了 `CDCOnBoot=cdc` |
| 装完插件 `--dump-config` 里没有它 | 见上面「pnpm ≥ 10 会拦构建脚本」 |
| 灯全灭，但 DSH 在跑 | 串口有没有 `READY`？插件的 `reconnectIntervalMs` 是 5 秒一次重连 |
| 黄灯呼吸一下就没 | 升级到 ≥ 1.0.0；旧版计划模式下会误熄 |
| 无线连不上 | 先看串口打印的 IP 对不对，再确认 `host` 填的是它 |
| 灯一直停在某个状态 | 5 分钟无命令会自动回 `off`；没回说明命令还在发 |

**串口被谁占着？** DSH 运行时独占串口，所以烧录前先把 DSH 停掉，或者换一个 USB 口。

---

## 卸载

```sh
dsh plugin --profile web remove dsh-led-bridge
```

---

## License

MIT
