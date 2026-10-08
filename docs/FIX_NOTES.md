# 2.1.0 修复记录

日期：2026-10-08（Asia/Shanghai）。基线提交：`ce246c3`。这份记录区分已验证的软件缺陷与尚未实测的硬件结果。

## 打开配网页重启

用户描述的触发是手机接入 ESP 自身的配网热点后打开网页，每次打开都重启；IP5306 + 锂电池接 5V，以及单独 USB 供电都能复现。用户无法提供有效串口日志。USB 复现说明 IP5306 不是必要条件，不能据此断定所有供电环节正常。

在原版真实函数中找到以下顺序：

```cpp
// loop() 先采样，例如 nowMs = 1000
webServer.handleClient();
// 网页回调随后将 lastConfigActivityMs 更新为 millis()，例如 1001
dnsServer.processNextRequest();
if (nowMs - lastConfigActivityMs > CONFIG_SESSION_MS) {
  // 原版随后直接 ESP.restart()
}
```

两个时间均是 `uint32_t`。`1000 - 1001` 的无符号结果为 `4294967295`，约 49.7 天，超过 10 分钟的 `CONFIG_SESSION_MS`。因此，只要 HTTP 回调取得的时间比传入服务函数的旧时间晚，原版就会将活跃页面误判为空闲并主动重启。扫描开始时间也有同类问题，会错误结束刚启动的扫描。这是一条确定的软件重启路径，与描述吻合；没有实物日志，仍不能证明它是设备上唯一的重启来源。

`tests/firmware_wifi_service_test.cpp` 使用假时钟与回调，执行脚本从 `.ino` 提取的真实 `serviceWifiStatus()` 函数：

| 场景 | 原版结果 | 修复版结果 |
| --- | --- | --- |
| 循环采样 1000 ms，页面回调记录 1001 ms | `restarts=1`，测试失败 | 没有重启或退出配网 |
| 回调刚启动异步扫描 | 存在同类无符号下溢路径 | 扫描保持运行 |
| 真正空闲超过 10 分钟且有已存网络 | 直接整机重启 | 退出 AP 并重试网络 |
| `millis()` 正常回绕 | 需保留这种合法时间差 | 回绕测试通过 |

修复在 HTTP/DNS 回调之后重新采样时间，网络收包之后也使用新时间做存活检查。保存凭据同步更新运行内存并延后切换连接，防止删除重启路径后仍使用旧凭据。保存、清除、模式切换与空闲恢复均不再主动整机重启。

配网页改为 Flash 静态内容，通过 `send_P()` 返回，避免整页 `String` 复制和反复替换。诊断按按钮读取，页面加载不自动扫描或发请求。AP 初始只开启 AP 模式；用户点击扫描时才启用 STA。路由只注册一次，避免重复进入配网增加处理器。配网使用认证、单客户端和 8 dBm 发射上限。

最小页面对照版使用同样的计时修复和 Wi-Fi 逻辑，去掉 JavaScript 与扫描界面。若普通版仍重启而最小版正常，可继续检查网页请求规模及相关路径；若两版都重启，也不能仅据此排除软件，需结合页面诊断信息继续定位。

## 欠压检测判断

原代码在 `setup()` 中再次调用私有 `esp_brownout_init()`。本次实际编译使用 Arduino-ESP32 3.3.11 / ESP-IDF 5.5.5；框架启动已初始化欠压检测。上游源码显示重复初始化会再次注册回调，不能据此声称一定发生断言、必然重启。已经移除重复调用与关闭欠压检测的开关，保留框架保护。这不是目前复现出的网页重启根因。

依据：[brownout 实现](https://github.com/espressif/esp-idf/blob/b774170ff46/components/esp_hw_support/power_supply/brownout.c)、[RTC ISR 注册](https://github.com/espressif/esp-idf/blob/b774170ff46/components/esp_hw_support/rtc_module.c)、[启动初始化](https://github.com/espressif/esp-idf/blob/b774170ff46/components/esp_system/startup_funcs.c)。供电后续核查可参考 [Espressif ESP32-C3 硬件检查表](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32c3/schematic-checklist.html)，不能将较低发射功率视为供电达标的证明。

## 其他研究报告问题

- 插件区分完成、失败与取消回合；读取嵌套工具错误、命令错误与 hook handlerId；seed 边界不再当作会话结束。
- 审批按 ID 聚合，回合结束清理，不再依赖超时自动解除；多会话分开跟踪并聚合到一盏灯。
- 状态与工具活动分开缓存；通知作为动作逐次发送，断线期间不重播通知；设备 READY、切换通道、重连和周期心跳恢复完整快照。
- 握手只接受目标身份；配网设备不能作为控制通道；异步写入错误关闭连接并重试；卸载清理连接、事件订阅和计时器。
- 扫描列表仅添加一次分隔符，正确转义 SSID，不把名字插入 HTML；保存、清除改为 POST；网络管理命令限制到串口。
- Wi-Fi 重试间隔与连续失败期限分开维护；15 秒连续失败进入配网。TCP/UDP 查询返回到原通道；通知结束不覆盖更新状态。
- 诊断创建父目录、各实例使用独立文件、写失败可见；配网密码从接收日志中脱敏。增加锁文件和构建脚本，统一版本为 2.1.0。

上游事件依据：[Session 类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts)、[消息类型](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/message.ts)、[事件目录](https://deepseek-harness.github.io/deepseek-harness/en/reference/persistence-catalog)。尚未运行用户实际 Harness 版本，集成兼容性需要实际确认。

## 验证与限制

22 项 Node 测试通过，其中包括真实本地 TCP 断开和重连；两组 C++ 测试通过，包括从实际固件提取函数的 HTTP 计时回归。原版的页面计时测试在修复前得到 `FAIL ... restarts=1`，修复后通过。使用真实 SerialPort 13 依赖可枚举端口，但当时没有串口设备，因此没有烧录硬件。

普通版与最小版以 Arduino-ESP32 3.3.11、4 MB、DIO/40 MHz、80 MHz CPU、CDC on boot 开启编译。最终数值以编译日志和产物为准；编译与函数测试不证明实物电源、射频、LED 和目标 Harness 的行为。

建议实物验证：USB 单独供电，普通版连续打开页面至少 20 次，扫描/保存目标网络，再复测 IP5306 供电。仍有问题时用最小版对照，并从页面读取诊断信息；无需先取得完整串口日志。
