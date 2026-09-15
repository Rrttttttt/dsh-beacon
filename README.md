# dsh-beacon

一个通过 dsh 插件串口广播 dsh 工作状态的插件，适用于 esp-32 c3 灯光控制。

> **本仓库当前装的是 `dsh-led-bridge`（试验版）。**
> `dsh-led-bridge` 是一个**验证 LED 灯的临时桥梁**：它只做一件事 —— 把 DeepSeek Harness
> 的工作状态通过 USB 串口推给 ESP32-C3，驱动一个三灯玩具红绿灯。
>
> **`dsh-beacon` 是最终形态**：它会把 bridge 的能力并进来，再加上系统托盘图标、
> 桌面悬浮球、Windows 通知、余额/消耗显示等多路输出。等 beacon 做出来时，
> bridge 会成为它的一个 sink。

---

## 它是做什么的

DSH（DeepSeek Harness）在干活时，状态只存在于电脑里。这个插件把它变成**抬头就能看见**的东西：

| 颜色 | 含义 |
|---|---|
| 🟡 黄灯**呼吸** | 模型正在思考 / 生成 |
| 🟡 黄灯**快闪** | **在等你确认**（权限申请） |
| 🟢 绿灯**常亮** | 一轮答完了 |
| 🟢 绿灯**呼吸**（与黄灯错相） | 有工具正在执行 |
| 🔴 红灯**常亮** | 出错 / 模型重试 |
| ⚫ 全灭 | 待机 |

**架构约定**：插件只报告**事实**（前景状态 / 计划模式 / 有无工具在跑），
**全部灯效渲染与时序都在固件里**。所以插件配置里没有任何灯效时长参数 ——
想调整观感（呼吸快慢、工具尾巴长短）改固件常量重烧即可。

---

## 安装

### 方式一：自包含包（推荐，零配置）

从 [Releases](https://github.com/Rrttttttt/dsh-beacon/releases) 下载 `dsh-led-bridge-<版本>.zip`，
解压后运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\dsh-led-bridge\install.ps1
```

它会自动完成注册，**不需要手工改任何配置文件**。脚本做三件事：
把插件放到 `~/.dsh/plugins/`（路径含空格时会自动换位置）、
`dsh plugin add` 注册进 profile、然后验证插件层是否真的生效。

### 方式二：npm 包

```sh
dsh plugin --profile web add dsh-led-bridge
```

> ⚠️ **这种方式需要手工加一项配置。** 插件的依赖 `serialport` 会拉下
> `@serialport/bindings-cpp`，它带 install 脚本；pnpm ≥ 10 默认拦截构建脚本并
> **以退出码 1 结束**，而 `dsh plugin` 只在退出码为 0 时才登记插件 ——
> 结果是包进了 `dependencies`，却**永远不进 `dsh.profile.bundles`**，
> DSH 静默不加载它。
>
> 在 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里加：
>
> ```yaml
> allowBuilds:
>   '@serialport/bindings-cpp': true
> ```
>
> 这一项**无法全局设置**（pnpm 会拒绝 `ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY`），
> 所以只能每台机器手工加。**这正是方式一存在的原因。**
> 详见 [docs/DISTRIBUTION.md](./docs/DISTRIBUTION.md)。

### 方式三：从源码

```sh
git clone https://github.com/Rrttttttt/dsh-beacon.git
cd dsh-beacon
dsh plugin --profile web add "link:$PWD/plugin"
```

同样需要上面那条 `allowBuilds`（源码没自带依赖树）。

**安装后都要重启 DSH** —— profile 配置只在启动时读一次，正在运行的 DSH
不会加载新装上的插件。

---

## 硬件

ESP32-C3（本工程用的是 ESP32-C3-MINI-1 / ESP32-C3FN4）原生 USB-Serial/JTAG，
不需要 CH340 之类的转串口芯片。

| 灯 | GPIO |
|---|---|
| 红 | GPIO5 |
| 黄 | GPIO6 |
| 绿 | GPIO7 |

固件源码在 [`firmware/esp32c3_dsh_status_light/`](./firmware/esp32c3_dsh_status_light/)，
用 Arduino IDE（esp32 core 3.x）编译烧录。编译选项见
[`scripts/build.ps1`](./scripts/build.ps1)。

> ⚠️ **板上必须烧了固件。** 出厂空 Flash 会让 ESP32-C3 反复复位
> （`invalid header` + `TG0WDT_SYS_RST`），Windows 就会不停播 USB 连接音。
> 灯效在固件里，插件只发文本命令 —— 没烧固件的话插件怎么装都不会有反应。

---

## 仓库结构

```
plugin/                     DSH 插件源码（纯 JS，跑在电脑上）
  lib/index.js              全部逻辑（单文件）
  cordis.patch.yml          DSH 挂载声明
firmware/                   ESP32-C3 固件
  esp32c3_dsh_status_light/ Arduino 工程（.ino）
scripts/                    工具脚本
  pack.ps1                  打包出两种安装形态
  install-dist.ps1          目标机安装脚本（会被打进自包含包）
  verify-all.mjs            总验证：静态 / 自测 / 协议 / 架构
  verify-dist.mjs           产物验证：确认打出来的包真的能装
  verify-no-lamp-logic.mjs  架构守卫：证明插件里没有灯效代码
  selftest.mjs              离线自测
  simulate.mjs              端到端模拟（含固件灯效规则的移植）
  build.ps1                 编译烧录固件
docs/                       说明文档
```

---

## 验证

```sh
node scripts/verify-all.mjs            # 逻辑全绿
node scripts/verify-no-lamp-logic.mjs  # 确认插件里没有灯效代码
powershell -File scripts/pack.ps1      # 打包
node scripts/verify-dist.mjs           # 确认产物可用
```

发版：

```sh
# 1. 改 plugin/package.json 的 version
# 2. 本地验证全绿
# 3. 打标签推送，GitHub Actions 会自动构建并创建 Release
git tag v0.2.2
git push origin v0.2.2
```

---

## 许可

MIT，见 [LICENSE](./LICENSE)。
