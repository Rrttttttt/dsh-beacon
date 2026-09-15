# 附属文件

本目录存放与代码分开的配套资料。

| 文件 | 内容 |
|---|---|
| [DSH事件与灯状态对应表.md](./DSH事件与灯状态对应表.md) | **权威映射表**。DSH 全部 56 种事件类型 → 灯状态的逐条对应，标明哪些已实现、哪些刻意忽略、想扩展时怎么加。 |
| [DISTRIBUTION.md](./DISTRIBUTION.md) | 分发方案对比。npm vs GitHub Releases vs tarball，各自的命令、授权要求与优劣。 |
| [参考资料/](./参考资料/) | 调研阶段抓下来的外部资料，**只作存档，不参与构建**。来源见下。 |

工程主体在上一级：

- `../plugin/` —— DSH 插件源码（跑在电脑上）
- `../firmware/` —— ESP32-C3 固件（跑在板子上）
- `../scripts/` —— 打包 / 安装 / 离线自测脚本
- `../README.md` —— 接线图、烧录步骤、安装方式、三步验证流程、排错表

---

## 参考资料/ 的来源说明

这些文件是 2026-09-13 调研阶段派出的一个研究子智能体抓取、落在工作区里的，
事后归档到这里。**它们不是本工程的依赖，删掉也能正常编译烧录**，保留只是为了留下溯源。

> 归档原则：**只保留官方原件**（厂商手册、上游源码），
> 当时的中间产物（两个一次性 Python 爬虫）已删除。
> 之所以需要爬虫：那个子智能体没有 harness 的 `web_search` / `web_fetch` 工具，自己写脚本抓的。

### `参考资料/Espressif-LEDC源码对比/` — 官方源码

用途：确认 **ESP32 Arduino 核心 3.x 移除了旧的 LEDC API**（`ledcSetup()` / `ledcAttachPin()`），
以及新 API（`ledcAttach(pin, freq, bits)` / `ledcWrite(pin, duty)`）的签名。
本工程固件的 LEDC 写法就是据此改的 —— **第一版固件因为用了旧 API 编译失败**。

| 文件 | 来源 | 版权头 |
|---|---|---|
| `hal-ledc-master.c` `.h` | https://github.com/espressif/arduino-esp32 — `cores/esp32/esp32-hal-ledc.c/.h`（master 分支） | `Copyright 2015-2023 Espressif Systems (Shanghai) PTE LTD` |
| `hal-ledc-2.0.17.c` | 同上仓库，标签 `2.0.17` 版本的同一文件（用于对比 API 差异） | `Copyright 2015-2016 Espressif Systems` |

许可：Apache License 2.0，版权归 Espressif Systems (Shanghai) PTE LTD，文件头保留了原始声明。

> 注：本机实际安装的核心是 **3.3.11**，最终验证是直接读
> `portable/packages/packages/esp32/hardware/esp32/3.3.11/cores/esp32/esp32-hal-ledc.h` 做的；
> 这两份源码只是当时用于版本对比的旁证。

### `参考资料/TI-BQ24074电池充电手册/` — 厂商手册

| 文件 | 说明 |
|---|---|
| `bq24074.pdf` | **TI BQ24074** 电池充电 IC 官方数据手册（来自 TI 官网，已核实为真 PDF 且含 TI 版权标识）。用途：将来给这个摆件加锂电池供电时要选的充放电模块 —— 需要支持「边充边用（power path）」且能扛 ≥400mA 峰值（ESP32-C3 Wi-Fi 发射峰值 335mA 实测值）。**当前阶段未使用** —— 现在是 USB 供电。 |

> 电池尚未采购、型号未定，所以这份手册只是候选参考，不是选型结论。


