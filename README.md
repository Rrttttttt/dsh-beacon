# dsh-beacon

一个通过 dsh 插件串口广播 dsh 工作状态的插件，适用于 esp-32 c3 灯光控制。

> ## ⚠️ 名字对不上是**故意的**，先看这段
>
> | 名字 | 是什么 | 现在的状态 |
> |---|---|---|
> | 仓库 `dsh-beacon` | **将来的最终形态**：ESP32 红绿灯 **+ 系统托盘 + 桌面悬浮球 + Windows 通知 + 余额/消耗** | 只有设计稿 |
> | 包 `dsh-led-bridge` | **今天就能用的试验版**：只把 DSH 状态推给 ESP32-C3 红绿灯 | ✅ 已发布、已实测 |
>
> 所以你在本仓库看到的、下载到的、安装的，**都是 `dsh-led-bridge`** ——
> Release 里的文件名、`package.json` 的包名、`dsh plugin` 里登记的 id，全都是它。
> `dsh-beacon` 目前只是一个仓库名。
>
> bridge 会**成为 beacon 的一个输出通道（sink）**，到那时才谈得上改名。
> 在那之前，本 README、`plugin/README.md`、`docs/` 说的都是 bridge。

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

> **架构约定**：插件只报告**事实**（前景状态 / 计划模式 / 有无工具在跑），
> **全部灯效渲染与时间控制都在固件里**。
>
> 插件配置里**没有任何灯效时长参数** —— 呼吸快慢、工具尾巴长短、空闲灭灯全在固件常量里，
> 改它们要重烧。插件里只有两个与"时长"沾边的键，都不是灯效：
> `alarmTimeoutMs`（防止灯卡在 alarm）与 `reconnectIntervalMs`（连不上板子时的重试间隔）。
> `scripts/audit-boundaries.mjs` 有一条白名单断言守着这个边界。

> **「空闲自动灭灯」也是固件独占的**（固件常量 `STALE_TIMEOUT_MS`，默认 5 分钟）。
> 插件曾经也有一份 `idleTimeoutMs`，已经删掉，因为那是同一件事的两份实现：
> 它是个**骗人的旋钮**（固件那份无条件生效，所以把它设成 0 或调大都不起作用），
> 而且两者语义不同（插件测「多久没有新状态」，固件测「多久没有串口活动」），
> 会让一次**很长的推理**被误判成空闲而灭灯。
> 要改这个超时：改 `.ino` 里的 `STALE_TIMEOUT_MS` 并重烧。

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
