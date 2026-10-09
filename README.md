# dsh-beacon

将 DeepSeek Harness 的运行状态显示在 ESP32-C3 三色灯上。模型生成、工具执行、等待审批、出错和完成，都有对应的灯效。

项目包含两部分：电脑端插件监听 Harness 会话事件，通过 USB 串口或 TCP 发送状态；固件接收命令并驱动 LED，同时提供 Wi-Fi 配网页。

**当前版本：固件 2.1.1，插件 2.1.0。** 2026-10-08 已完成烧录与配网测试，用户确认实物验证通过。软件验证包括 23 项 Node 测试、两组 C++ 回归测试，以及普通版和最小配网页固件编译。

~~~mermaid
flowchart LR
    H[DeepSeek Harness] --> P[状态插件]
    P --> U[USB 串口 / TCP]
    U --> E[ESP32-C3]
    E --> L[红 / 黄 / 绿 LED]
~~~

## 硬件与接线

已验证设备为 ESP32-C3 QFN32 revision v0.4，XMC 4 MB Flash，使用原生 USB Serial/JTAG。其他 ESP32-C3 板卡使用前应核对引脚占用、USB 接口和 Flash 容量。

| 信号 | 引脚 / 设置 |
| --- | --- |
| 红灯 | GPIO5 |
| 黄灯 | GPIO6 |
| 绿灯 | GPIO7 |
| 模式开关 | GPIO4 与 GND 之间的开关，固件开启内部上拉 |
| 共阳 LED 公共端 | 3V3，低电平点亮；每路需要合适的限流电阻 |
| 共阴 LED | 公共端接 GND，并将固件 `ACTIVE_LOW` 改为 `false` |

| 开关状态 | 运行模式 |
| --- | --- |
| 断开 | USB 串口模式，Wi-Fi 关闭 |
| 闭合，GPIO4 接 GND | Wi-Fi 模式，连接目标网络或开启配网热点 |

运行中拨动开关会直接切换模式，无需整机重启。

## 快速开始

### 1. 获取项目

需要 Node.js >=20；编译固件还需要 Arduino CLI 和 ESP32 平台。Windows 建议使用不含空格的项目路径，方便 Harness 的本地插件安装。

~~~powershell
git clone https://github.com/Rrttttttt/dsh-beacon.git
cd dsh-beacon
npm ci
~~~

### 2. 编译和烧录

预编译固件可从 [GitHub Releases](https://github.com/Rrttttttt/dsh-beacon/releases) 下载。普通版提供 Wi-Fi 扫描和可点击的网络列表；最小版仅提供手动输入。每个版本都有完整镜像和应用镜像，并附烧录说明及 SHA-256 校验值。

**Release 固件不内置固定配网密码。** 首次进入配网时，设备生成并保存随机密码。用 USB 串口监视器（115200 波特率）读取 `CONFIG AP=... password=...`；若错过该行，可将开关切到 USB 档再切回 Wi-Fi 档。应用更新保留现有 NVS 中的密码。关闭串口监视器后再启动插件，分享日志前隐藏密码。

已验证环境为 **Arduino CLI 1.3.1 / Arduino-ESP32 3.3.11**。默认构建参数：

| 参数 | 值 |
| --- | --- |
| 板型 | ESP32C3 Dev Module |
| USB CDC on boot | 开启 |
| Flash | 4 MB，DIO，40 MHz |
| CPU | 80 MHz |
| 分区 | 默认 |

~~~powershell
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.11 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
./scripts/Build-Firmware.ps1
~~~

脚本生成：

- `.build/firmware/`：普通版固件。
- `.build/ap-password.txt`：本次构建的随机配网热点密码。后续构建复用此文件，普通版和最小版使用同一密码。

公开发布时使用 `./scripts/Build-Firmware.ps1 -Release`；最小版再加 `-MinimalConfig`。输出分别为 `.build/firmware-release/` 和 `.build/firmware-minimal-release/`，不读取或嵌入本地密码，采用设备生成密码的方式。

烧录时按镜像类型选择地址：

| 文件 | 地址 | 用途 |
| --- | --- | --- |
| `esp32c3_dsh_status_light.ino.merged.bin` | `0x0` | 完整烧录，覆盖整个 4 MB Flash，会清除旧 Wi-Fi 配置 |
| `esp32c3_dsh_status_light.ino.bin` | `0x10000` | 应用更新；相同 core、板型和分区下保留 NVS 配置 |

**应用镜像不能烧到 `0x0`。** 首次安装使用完整镜像；仅更新应用时，先确认现有分区配置一致。设备会在烧录结束后复位启动。

使用 Arduino IDE 时打开 `firmware/esp32c3_dsh_status_light/esp32c3_dsh_status_light.ino`，按上表设置板型和 USB 选项。IDE 直接编译不使用构建脚本生成的密码：设备会生成并保存自己的随机密码，进入配网时从串口读取 `CONFIG AP=... password=...`。分享日志前应隐藏密码。

### 3. 选择连接方式

**USB：** 模式开关断开，连接 USB。插件默认按 `VID 303a / PID 1001` 发现设备，串口波特率为 115200。使用其他 USB 桥或自动发现失败时，配置具体串口。

**Wi-Fi：**

1. 闭合模式开关。没有凭据或连接失败时，红灯慢闪，设备开启 `DSH-Beacon-XXXX`。
2. 手机连接该热点。默认本地构建使用 `.build/ap-password.txt` 中的密码；Release 或 IDE 直接编译的固件从串口读取密码，方法见上文。
3. 浏览器打开 `http://192.168.4.1/`。若手机没有自动弹出配网页，手动打开此地址。
4. 点击“扫描附近 Wi-Fi”。结果直接显示为网络名称按钮，同名接入点合并；点击即可填入 SSID，也可手动填写。
5. 填写目标 **2.4 GHz** 网络的密码，点击保存。设备关闭配网热点并连接目标网络，无需整机重启。

目标是手机热点时，先记下热点名称和密码；临时连接 ESP 热点填写，保存后重新开启手机热点。约 15 秒连接失败后，ESP 会回到配网模式，可以再次填写。

连接成功后 ESP 自身热点关闭，所以此时无法再连接 `DSH-Beacon-XXXX` 属于正常行为。需要重新配网时，可关闭目标网络等待回到配网模式，或使用串口 `wifi clear` 清除凭据。

### 4. 安装 Harness 插件

在仓库根目录安装依赖后，将项目加入实际使用的 Harness profile。以下以 `web` 为例，请替换为自己的 profile 和项目绝对路径：

~~~powershell
dsh plugin --profile web add "link:C:/dsh-beacon"
dsh --profile web --dump-config
~~~

检查配置中出现 `dsh-led-bridge`，然后重启 Harness。项目路径应指向含 `package.json` 的仓库根目录。

有线配置示例：

~~~yaml
- id: dsh-led-bridge
  config:
    transport: serial
    port: COM4  # 不填则自动发现
~~~

无线配置示例：

~~~yaml
- id: dsh-led-bridge
  config:
    transport: tcp
    host: 192.168.1.42
    tcpPort: 8234
~~~

`host` 是设备接入目标网络后的地址，可从串口 `wifi?` 或路由器查看；它不是配网地址 `192.168.4.1`。电脑必须能访问设备所在网络。若 DHCP 地址变化，需要更新配置。

配置示例应合入该 profile 的实际插件配置层；使用 `--dump-config` 确认生效。目标 Harness 版本的安装与配置行为仍应以实际环境为准。

## 灯效

| 状态 | 灯效 |
| --- | --- |
| 待机 `off` | 全灭 |
| 模型生成 `thinking` | 黄灯呼吸 |
| 生成中且有工具执行 | 黄绿错相呼吸 |
| 错误 `error` | 红灯常亮 |
| 等待审批 `alarm` | 黄灯快闪 |
| 成功完成 `success` | 绿灯常亮 |
| 计划模式 `plan` / `+plan` | 绿灯常亮，可叠加基础状态 |
| 通知 `notify` | 绿灯闪两次，随后恢复或切到指定状态 |
| 配网模式 | 红灯慢闪 |

固件还支持 `busy`（绿灯慢闪），内置插件目前不主动发送它。

失败和取消回合不会显示为成功。工具按 ID 跟踪并发活动，最后一个结束后撤掉工具提示。审批按 ID 保持到决定或回合结束，旧 `alarmTimeoutMs` 字段不再自动解除审批显示。

默认聚合多个会话：等待审批优先，其次是活动会话中的错误和最近活动状态。可用 `sessionId` 限制跟踪一个会话。

## 插件配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `transport` | `auto` | `serial`、`tcp` 或 `auto`；自动模式优先已确认身份的串口 |
| `host` | 空 | 设备在目标网络中的地址 |
| `tcpPort` | `8234` | TCP 端口 |
| `port` | 空 | 指定串口，例如 `COM4` |
| `vendorId` / `productId` | `303a` / `1001` | 自动串口匹配 |
| `baudRate` | `115200` | 串口波特率 |
| `reconnectIntervalMs` | `5000` | 重连间隔，实际最小为 1000 ms |
| `handshakeTimeoutMs` | `5000` | 身份握手超时 |
| `heartbeatIntervalMs` | `30000` | 完整状态心跳，有效范围 1000–60000 ms |
| `sessionId` | 空 | 空值表示聚合会话 |
| `diagnosticPath` | 空 | 自定义诊断文件位置 |

设备返回 `ESP32_STATUS_LIGHT READY` 后才成为可用通道。设备重新启动、重连、切换通道和周期心跳都会恢复“状态 + 工具活动”快照；通知是动作，断线期间不会补播。

诊断默认写入用户目录 `.dsh/dsh-led-bridge.<pid>.<instance>.state.json`。`queued` 表示写入排队，`written` 表示驱动回调成功，`acknowledged` 表示设备返回 `OK`。

## 通信与诊断

每条命令以换行结束。固件支持 USB 串口、TCP 和 UDP；插件使用串口或 TCP。TCP/UDP 端口均为 8234。

~~~text
hello
thinking
tools on
notify success
state?
wifi?
~~~

`hello` 返回身份信息，`ping` 返回回执，`state?`、`wifi?`、`power` 将诊断返回到请求所在通道。`off`、`thinking`、`busy`、`error`、`alarm`、`success`、`plan` 支持 `+plan` 修饰。

串口还支持：

- `wifi clear`：清除凭据并重新配网。
- `wifi <SSID> <密码>`：保存凭据；含空格的 SSID 请使用网页。
- `power tx <数值>`：可选 20、13、8、5、2 dBm；默认 STA 上限 13 dBm，配网 AP 为 8 dBm。

欠压保护由 ESP-IDF 管理，固件拒绝关闭。TCP/UDP 允许状态控制和只读诊断，管理操作限制在 USB 串口；HTTP 表单负责配网。TCP/UDP 状态控制没有额外认证，应使用可信局域网。

设备 5 分钟没有收到有效状态或保活命令会熄灯。插件每 30 秒发送完整状态心跳，正常长任务不会因重复状态被去重而失去显示。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| USB 没有串口 | 核对原生 USB 接线、数据线和 CDC on boot；其他 USB 桥使用具体串口 |
| 烧录提示端口占用 | 关闭 Harness、串口监视器及其他占用该端口的程序 |
| Windows 编译出现链接路径错误 | 将临时构建目录设为 ASCII 路径，例如 `-BuildRoot 'C:/dsh-build'` |
| 插件安装后不生效 | 检查 `--dump-config` 并重启 Harness；本地路径尽量不含空格 |
| 扫描发现同名网络 | 2.1.1 按 SSID 去重；刷新并确认页面版本 |
| 保存后 ESP 热点消失 | 已切到连接目标网络；重新开启目标热点并确认其为 2.4 GHz |
| TCP 连不上 | 核对 `host`、同网可达性及端口；配网 AP 地址不能当作目标连接地址 |
| 需要查看复位信息 | 配网页点击“读取诊断信息”，或查看串口 `BOOT reset=`、`READY` |

2.1.0 已修复打开配网页时旧时间戳造成的无符号下溢：活跃请求曾被误判为空闲约 49.7 天并触发重启。实物监测中连续页面请求未再引发复位；具体证据见 [修复记录](docs/FIX_NOTES.md)。

## 开发与验证

~~~powershell
npm test
./scripts/Test-Firmware.ps1
~~~

原生固件测试需要 C++17 编译器。脚本识别 `.tools/zig/` 中的 Zig，也可传 `-Compiler <g++路径>`；使用指定 Zig 时加 `-Zig`。配网计时测试提取并执行实际固件服务函数，覆盖 HTTP 回调、真正空闲超时和时钟回绕。

构建脚本可传 `-CliPath`、`-CoreData`、`-BuildRoot` 和 `-CpuMHz 160`。最小配网页对照版：

~~~powershell
./scripts/Build-Firmware.ps1 -MinimalConfig
~~~

产物位于 `.build/firmware-minimal/`，保留手动填写表单与诊断链接，使用同一配网密码。

本次实物验证覆盖 USB 连接条件下的烧录、配网页访问、网络连接、断网恢复和用户确认的新版界面。IP5306 供电专项复测、长期稳定性、同网 TCP 实物验收和实际 Harness 运行集成仍未完成。

## 仓库结构

~~~text
lib/index.js                              Harness 插件
package.json / cordis.patch.yml            插件元数据与安装补丁
firmware/esp32c3_dsh_status_light/          ESP32-C3 固件及共享逻辑
scripts/                                  构建与测试脚本
test/                                     Node 回归测试
tests/                                    C++ 固件回归测试
docs/FIX_NOTES.md                          修复与实物验证记录
PROJECT_RESEARCH.md                       修复前基线研究
~~~

Git 只保存源码、锁文件、文档和测试。依赖、工具、下载、构建目录、固件二进制、运行日志、配网密码和含密码的临时构建头文件均被忽略。`PROJECT_RESEARCH.md` 中的旧路径和行号对应基线提交。

## 许可证

[MIT](LICENSE)
