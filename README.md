# ESP32-C3 DeepSeek Harness 状态灯

电脑端插件监听 DeepSeek Harness 会话事件，经 USB 串口或 TCP 控制 ESP32-C3 的红、黄、绿 LED。当前固件版本为 **2.1.1**，插件版本为 **2.1.0**。

已修复“打开配网页立即重启”的计时缺陷，并在 USB 供电的实物上完成配网页访问、保存并连接网络、断网回到配网的验证。2.1.1 进一步让扫描结果直接显示为可点击的列表，并按 SSID 去重。证据与边界见 [修复记录](docs/FIX_NOTES.md)；[初始研究报告](PROJECT_RESEARCH.md)描述修复前的基线。

## 硬件与构建设置

| 项目 | 设置 |
| --- | --- |
| 目标芯片 | ESP32-C3，4 MB Flash；用户提供的是 QFN32 revision v0.4、XMC Flash |
| 已验证编译环境 | Arduino CLI 1.3.1；Arduino-ESP32 3.3.11 |
| 板型 | ESP32C3 Dev Module (`esp32:esp32:esp32c3`) |
| 默认编译选项 | USB CDC on boot 开；DIO；Flash 40 MHz；CPU 80 MHz；4 MB；默认分区 |
| 串口 / TCP、UDP | 115200 baud / 8234 |
| LED | GPIO5 红、GPIO6 黄、GPIO7 绿；`ACTIVE_LOW=true`，低电平点亮 |
| 模式开关 | GPIO4 拉低接 GND 为 Wi-Fi 模式，断开为 USB 模式；运行中拨动直接切换 |

共阳 LED 的公共端接 3V3，各颜色需要合适的限流电阻。芯片型号不能确定整块开发板的引脚占用与供电电路，接线仍应核对实际板卡。

## 编译固件

准备 Arduino CLI 和 `esp32:esp32@3.3.11` 平台，然后在仓库根目录运行：

```powershell
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.11 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
./scripts/Build-Firmware.ps1
```

脚本会优先使用本地 `.tools/arduino/arduino-cli.exe`，也可传 `-CliPath`。使用既有便携 Arduino 数据目录时传 `-CoreData`，例如：

```powershell
./scripts/Build-Firmware.ps1 -CoreData 'D:/Agent Workstation/arduino/Arduino-IDE/portable/packages' -BuildRoot 'C:/Temp/dsh-status-build'
./scripts/Build-Firmware.ps1 -MinimalConfig -CoreData 'D:/Agent Workstation/arduino/Arduino-IDE/portable/packages' -BuildRoot 'C:/Temp/dsh-status-minimal'
```

ESP32 的 Windows 链接器不能可靠处理中文构建输出路径，脚本因此要求临时构建目录为 ASCII 路径。项目与最终输出目录可以包含中文。没有指定 `-BuildRoot` 时使用系统临时目录；若该目录也含中文，请显式指定。CPU 可通过 `-CpuMHz 160` 调整，默认 80。

- 普通版产物：`.build/firmware/`。
- 最小配网页产物：`.build/firmware-minimal/`，没有 JavaScript 和 Wi-Fi 扫描按钮，保留手动填写表单。
- 两个版本共用本地随机密码文件 `.build/ap-password.txt`。该密码通过临时头文件编入固件，不输出到编译日志，也不进入 Git。每份共享同一编译产物的设备会使用同一密码；为另一份固件生成新密码时，先保存原密码文件，再另建构建工作区。

直接在 Arduino IDE 编译 `.ino` 时没有这个构建宏，设备会生成并保存自己的随机配网密码，首次进入配网时从串口读取 `CONFIG AP=... password=...`。分享串口日志前应隐藏这行密码。

## 烧录与配网

1. 选择 ESP32-C3、4 MB Flash，使用生成的 `esp32c3_dsh_status_light.ino.merged.bin`，烧录地址为 **`0x0`**。合并镜像覆盖整个 4 MB Flash，会清除已保存的 Wi-Fi 凭据等设置。单独的 `.ino.bin` 是应用镜像，不能当作完整镜像烧到 `0x0`。
2. GPIO4 切换到 Wi-Fi 档。没有凭据时红灯慢闪，设备开启 `DSH-Beacon-XXXX` 配网热点。
3. 手机连接此热点，密码在 `.build/ap-password.txt`；浏览器打开 **`http://192.168.4.1/`**。
4. 填写目标 2.4 GHz 网络的 SSID 和密码，可手动填写或点击扫描。保存后直接连接，配网热点关闭；连接失败约 15 秒后回到配网模式，不进行整机重启。
5. 接入手机热点时，先记录手机热点名称和密码，再临时连接设备配网热点填写；保存后重新开启/切回目标热点。电脑使用 TCP 控制时必须能访问设备所在网络。

连接目标网络后，设备自己的配网热点会关闭，这是预期行为。需要重新配网时，可暂时关闭目标网络，等待设备连续连接失败约 15 秒后重新开启配网热点；或在串口使用 `wifi clear` 清除凭据。扫描完成后直接显示网络名称按钮，点按即可填入 SSID；同名接入点合并为一项，仍允许手动填写名称。

保持相同 core、板型和分区配置的应用更新，可将 `.ino.bin` 烧到 `0x10000`，保留 NVS 配置。本次 2.1.1 实物更新使用此方式。完整 `.merged.bin` 的烧录地址仍是 `0x0`，两者不能混用。

验证本次问题时，先使用普通版，连续打开/刷新配网页至少 20 次，再保存凭据。通过标准是热点持续可连接、页面持续可打开，且没有重复开机灯效；真正的 10 分钟空闲才会重试已存网络。如果仍重启，可刷最小配网页版进行对照，两版密码相同。无需串口：页面中的“读取诊断信息”或最小版的同名链接可显示复位原因、上次运行阶段、启动次数和剩余堆内存。

## 插件安装与配置

Node.js >=20。在插件目录执行 `npm ci`，随后使用目标 Harness 的插件安装命令；已核对的上游用法为：

```powershell
cd v2.0/plugin
npm ci
dsh plugin --profile <profile> add .
dsh --profile <profile> --dump-config
```

`cordis.patch.yml` 默认插入插件。配置字段加到实际 profile 的 `dsh-led-bridge` 插件配置下；先用 `--dump-config` 检查该版本 Harness 的配置层。典型字段：

```yaml
transport: tcp
host: 192.168.1.123  # 设备在目标网络上的地址，不是配网 AP 地址
tcpPort: 8234
heartbeatIntervalMs: 30000
```

有线可设置 `transport: serial`、`port: COM5`。默认 `transport: auto`，串口身份确认成功后优先，配置了 `host` 时同时尝试 TCP。自动串口发现优先匹配 `303a:1001`，其他 USB 桥应指定 `port`。

插件每 30 秒强制发送完整状态与工具活动快照。新 `READY`、重连和通道切换也恢复快照。`sessionId` 可限制单个会话；默认聚合会话，等待审批优先，再是活动会话的错误和最近活动状态。旧 `alarmTimeoutMs` 字段不再自动取消审批显示，审批必须有决定或回合结束。

诊断默认写到用户目录 `.dsh/dsh-led-bridge.<pid>.<instance>.state.json`，也可配置 `diagnosticPath`。`queued`、`written`、`acknowledged` 分别指排队写入、驱动回调成功、设备 `OK` 回执，不能互相替代。

## 协议与灯效

命令为换行结尾的文本。`hello` 返回 `ESP32_STATUS_LIGHT READY ...` 身份信息，`ping` 返回回执。串口、TCP/UDP 查询 `state?`、`wifi?`、`power` 都在请求所在通道返回结果。TCP/UDP 只接受状态、通知与只读诊断，清除凭据、修改发射功率需使用 USB 串口；HTTP 表单仍负责配网。TCP/UDP 状态控制本身没有额外认证，运行在可信局域网内。

| 命令 | 灯效 |
| --- | --- |
| `thinking` | 黄灯呼吸 |
| `thinking` + `tools on` | 黄绿错相呼吸 |
| `error` | 红灯常亮 |
| `alarm` | 黄灯快闪，等待审批 |
| `success` | 绿灯常亮 |
| `off` | 全灭 |
| `plan` / `+plan` | 绿灯常亮，可叠加基础状态 |
| `notify [状态]` | 绿灯闪两次，恢复或切到指定状态；更新的状态优先 |

串口还支持 `wifi clear`、`wifi <SSID> <密码>`、`power tx 20/13/8/5/2`（输入其中一个数值）。含空格的 SSID 使用网页表单。默认 STA 发射上限 13 dBm，保留已有合法设置，配网 AP 为 8 dBm。欠压保护始终由框架管理，拒绝 `power bod off`。

## 验证

```powershell
cd v2.0/plugin
npm test
cd ../..
./scripts/Test-Firmware.ps1
```

固件原生测试需要 C++17 编译器：可传 `-Compiler <g++路径>`，使用 Zig 时另传 `-Zig`；脚本也识别 `.tools/zig/` 下的编译器。测试覆盖配网回调计时、真实空闲超时、时钟回绕、保存凭据后直接切换、断网重试、转义和通知收尾。HTTP 计时测试提取并执行实际 `.ino` 中的服务函数，用假时钟和 HTTP 回调复现问题，不代表真实 Wi-Fi 射频或供电测试。

已完成：23 项 Node 测试、两组 C++ 回归测试、普通与最小配网页固件编译，以及 USB 供电下的实物烧录、配网页访问、目标网络连接和断网恢复验证。IP5306 供电复测、长期稳定性、LED 接线与供电测量、目标 Harness 运行集成仍未完成。电脑当前不在设备目标网络上，本次 TCP 实物探测未能建立连接；软件的本地 TCP 回归测试通过。`.tools`、`.build`、编译产物、密码与依赖目录均排除在 Git 之外。
