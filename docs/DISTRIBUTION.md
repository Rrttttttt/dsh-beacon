# 分发方案：两种安装形态

本插件有**两种安装形态**，对应两类用户。差别不是偏好问题，是**依赖装在哪**的问题。

| | 形态 A：自包含包 | 形态 B：npm tarball |
|---|---|---|
| 产物 | `dsh-led-bridge-<版本>.zip` | `dsh-led-bridge-<版本>.tgz` |
| 取得方式 | GitHub Releases 下载 | npm，或 Release 附件 |
| 用户命令 | 解压 → `install.ps1` | `dsh plugin --profile web add dsh-led-bridge` |
| **需要改配置吗** | **不需要** | **需要加一项 `allowBuilds`** |
| 运行时依赖 | 随包自带（2.7 MB） | 安装时从 registry 拉 |
| 包体积 | 1.07 MB（压缩后） | 19.6 KB |
| `package.json` 里的 `dependencies` | **无**（依赖树就在旁边） | **有 `serialport`**（没有依赖树，只能靠声明去拉） |

> ⚠️ **两种形态在 `dependencies` 上是相反的，别搞混。**
> 详见第七节的事故记录 —— 弄反会发出一个"装得上但跑不起来"的包。

---

## 一、为什么会有这个差别（实测数据）

下面每一条都是在**独立测试 profile** 上跑出来的，不是推测。

### 门槛来自 pnpm 的构建脚本拦截

`dsh plugin` 的实现（`dsh/lib/plugin-*.js`）：

```js
const result = spawnSync("pnpm", args, { cwd: dir, shell: true })
const exitCode = result.status ?? 1;
if (exitCode === 0) reconcilePlugins(before, dir);   // ← 非 0 就跳过登记
```

pnpm ≥ 10 默认**不执行依赖的构建脚本**，并且**以退出码 1 结束**。于是：

| 实验 | 做法 | 结果 |
|---|---|---|
| 1 | 干净 profile + `dsh plugin add <tgz>`（声明了依赖） | pnpm 退出 1（`ERR_PNPM_IGNORED_BUILDS`）。包**进了 `dependencies`，却没进 `dsh.profile.bundles`** |
| 2 | 把 profile 里 `allowBuilds` 占位改成 `true` 后重跑 | pnpm 退出 0 → ✅ 登记成功，`serialport` 加载正常 |
| 3 | `pnpm config set allowBuilds … --global` | **被 pnpm 拒绝**：`ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY` |
| 4 | 插件**不声明 `dependencies`** + 自带依赖树 | pnpm 退出 **0（65 ms）** → ✅ 登记成功，profile 里**完全没有 `allowBuilds`** |
| 5a | `file:<目录>` 安装 | ❌ `node_modules` 被排除 → `Cannot find package 'serialport'` |
| 5b | `link:<目录>` 安装 | ✅ junction 保留自带 `node_modules` |

**实验 1 的后果最值得警惕**：安装命令看起来跑完了，包也进了 `dependencies`，
但插件**永远不进 `dsh.profile.bundles`** —— DSH 静默不加载它。
用户看到的是"装成功了但灯没反应"，极难自查。

### `allowBuilds` 只能逐机手工加

它是 YAML 配置键，pnpm 明确拒绝写进全局 `config.yaml`：

```
Error: ERR_PNPM_CONFIG_SET_UNSUPPORTED_YAML_CONFIG_KEY
  × The key "allowBuilds" isn't supported by the global config.yaml file
  help: Try setting them instead to the local pnpm-workspace.yaml file
```

### 一个常见的误判：以为它在编译

**不是编译失败。** `@serialport/bindings-cpp@13.0.0` **自带 13 个平台的预编译
`.node`**（win32-x64/arm64/ia32、linux-x64/arm64/arm、linux-musl、darwin、android），
走 N-API，跨 Node 版本通用。它的 `scripts.install` 是 `node-gyp-build`，
**优先用预编译，找不到才编译**。

所以 `allowBuilds` 那一项**不会真的在你机器上编出什么东西**，
它纯粹是让 pnpm 愿意退出 0。但**它仍然是一个授权决定** ——
官方文档原话是"允许该包的代码在安装时于你的机器上执行，且不在 agent 运行的任何沙箱之内"。

### 补充：`pnpm pack` 永远排除 `node_modules`

试过把它写进 `package.json` 的 `files` 字段 —— **无效**。
所以自包含形态**不可能是 `.tgz`**，只能是目录。这正是形态 A 用 zip 而不是 tgz 的原因。

---

## 二、形态 A 为什么能零配置

两个关键设计：

**1. 出货副本不声明 `dependencies`。**
`scripts/pack.ps1` 先把依赖装进 `plugin/node_modules`，**然后从出货的
`package.json` 里删掉 `dependencies` 字段**。pnpm 于是只装 1 个包、退出 0、
登记插件，**完全不需要 `allowBuilds`**。
源码里的 `package.json` 保留声明（npm tarball 需要它）。

**2. 用 `link:` 而不是 `file:`。**
`file:` 只复制 `package.json` 的 `files` 白名单，**丢掉 `node_modules`**；
`link:` 建 junction，自带依赖树原样保留。

### 顺带：为什么路径含空格要换位置，以及为什么每个 profile 各存一份

**路径含空格**：`dsh plugin` 用 `shell: true` 转发给 pnpm，Windows 下**参数引号会丢**：

```
link:D:\Agent Workstation\...\plugin
  → pnpm 收到  link:D:\Agent  +  Workstation\...\plugin
  → 去 registry 找一个叫 "Workstation\...\plugin" 的包 → 404
    ERR_PNPM_PACKAGE_MANAGER_ADD_RESOLVE_LATEST
```

DSH 自己的 `anchorPathSpec()` 不解决这个 —— 它只重写 `.` / `..` 开头的相对路径。
Windows 8.3 短名本是干净解法，但该卷上常常是关闭的（本机实测关闭）。

**每个 profile 各存一份**：`install.ps1` 把插件暂存到
`$DSH_HOME\plugins\<插件名>-<profile>\`，**不是**一个所有 profile 共用的目录。

原因是共用会造成静默破坏：装第二个 profile（比如测试用的）会**替换掉第一个
profile 正在用的插件**。这个坑在开发这个安装脚本时真实踩到了，还得手工修回来。
每个 profile 各一份之后，`-Profile web` 和 `-Profile scratch` 互不影响，
卸载也只是删个目录。

---

## 三、动手打包

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\pack.ps1
node scripts\verify-dist.mjs
```

产出：

```
dist/
├─ dsh-led-bridge/              自包含目录（形态 A 的展开态）
│  ├─ install.ps1
│  ├─ DISTRIBUTION.md
│  ├─ LICENSE
│  └─ plugin/
│     ├─ lib/index.js
│     ├─ cordis.patch.yml
│     ├─ package.json          ← 无 dependencies
│     ├─ README.md
│     ├─ LICENSE
│     └─ node_modules/         ← 自带运行时依赖（含 13 个平台的预编译绑定）
├─ dsh-led-bridge-<版本>.zip    ← 发给用户的就是它
├─ dsh-led-bridge-<版本>.tgz    ← 发 npm / 挂 Release 用
└─ SHA256SUMS.txt
```

`verify-dist.mjs` 会逐项断言产物真的能装，包括：
出货 manifest 无 `dependencies`、依赖树里有预编译绑定、
`install.ps1` 是纯 ASCII、zip 里真的带了 `node_modules`、
所有产物的 `lib/index.js` 与源码 SHA256 一致。

### 为什么 `install.ps1` 必须是纯 ASCII

Windows PowerShell 5.1 会把**没有 BOM 的 `.ps1`** 按系统 ANSI 代码页解码，
在中文 Windows 上会把非 ASCII 内容变成乱码。`verify-dist.mjs` 会检查这一点。

### 打包时的一个坑：npm 会向上找 node_modules

`npm install` 会**向上遍历目录树**寻找已有的 `node_modules`，并且很可能判定
"up to date" 什么都不装。`dist/.../plugin` 位于仓库内，必然命中这个行为。
所以 `pack.ps1` 把安装放进一个**没有祖先 `node_modules` 的独立暂存目录**，
再把结果搬到位。

---

## 四、发布到 npm（可选）

npm 上 `dsh-led-bridge` 目前**未被占用**（实测 404）。

```sh
cd plugin
npm login
npm publish --access public
```

发布前检查：

- [ ] `plugin/package.json` 的 `version` 已递增
- [ ] `files` 只含该发的：`lib`、`cordis.patch.yml`、`README.md`、`LICENSE`
- [ ] `lib/index.js` 就是最终产物（纯 JS，无构建步骤）
- [ ] `dependencies` 里有 `serialport`（npm 安装要靠它）
- [ ] 没有把 `.env`、密钥、`node_modules`、`dist/` 发上去

> npm 的包名是全局先到先得。想保住这个名字就得先发出去。

**要启用自动发布**：`.github/workflows/release.yml` 目前**不发 npm** ——
发 npm 需要账号凭据，应当是显式动作。要自动化请另加 job 并配置 `NPM_TOKEN`。

---

## 五、安全提醒

插件代码**跑在 DSH 进程内部**，也就是拥有该进程的全部能力：
能读凭据文件（`~/.dsh/.credentials.yaml`）、能读写文件、能起子进程。

1. 本插件只做三件事：订阅会话事件、算状态、写串口。
2. 用户侧：从源码安装时的构建授权"不在 agent 运行的任何沙箱之内"，
   只该对信任的来源授权。
3. 本插件的依赖只有 `serialport` 一个（成熟库），没有其他传递依赖风险来源。

---

## 六、事故记录（都是真实发布出去过、或差点发布出去的）

记在这里是为了**别重犯**，尤其是那些"表面成功、实际坏掉"的类型。

### v0.2.0 / v0.2.1 的安装脚本会覆盖别的 profile（v0.2.2 已修）

**症状**：往一个测试 profile 里装插件，**正在使用的正式 profile 的插件被替换了**。

**根因**：安装脚本把所有 profile 都暂存到同一个共享目录
`~/.dsh/plugins/dsh-led-bridge`。装第二个 profile 时它先删除该目录再重建，
于是一个 profile 的安装静默破坏了另一个 profile 的安装。

**修法**：改成每个 profile 各存一份 —— `$DSH_HOME\plugins\<插件名>-<profile>\`。
验证方式是两个 profile 各装一次，然后断言两者的符号链接**指向不同路径**。

**教训**：安装脚本会写用户机器上的**全局**位置时，必须想清楚"再装一次"会不会
破坏已有安装。共享路径 + 先删后建 = 静默破坏。

### v0.2.0 的 tarball 是坏的：装得上，但跑不起来

**症状**：`dsh plugin add dsh-led-bridge-0.2.0.tgz` 退出码 0、插件进了
`dsh.profile.bundles`，看起来一切正常。但插件运行时**解析不到 `serialport`**，
于是静默降级成「未安装 serialport 依赖，无法使用串口」——**灯永远不动**。

**根因**：打包脚本让 tarball 也从**剥掉 `dependencies` 的 vendor 副本**打包。
而 `pnpm pack` 永远排除 `node_modules`，所以那个 tarball：
既带不了依赖树、又没声明依赖 → pnpm 装了 **0 个依赖** → 必然解析失败。

**这是个逻辑死结，必须靠"两种形态相反"来解**：

| 形态 | `dependencies` | 为什么 |
|---|---|---|
| 自包含目录 / zip | **无** | 依赖树就在旁边的 `node_modules`，声明了反而触发 `allowBuilds` 门槛 |
| tarball | **有 `serialport`** | 没有依赖树，只能靠声明去 registry 拉（代价是要 `allowBuilds`） |

**修法**：`pack.ps1` 为 tarball 单独建一份 staging，manifest 用**源码的**
（保留 `serialport` 声明）；只有 zip 用剥掉依赖的版本。
`verify-dist.mjs` 加了断言分别守住这两条相反的要求 —— 正是"少了一个包"这种
错误最难靠肉眼发现。

**教训**：**"安装成功"不等于"装对了"。** 判断标准必须是"从安装位真的能 `import`
到依赖"，而不是"命令退出码是 0"。现在 `install.ps1` 和 `verify-dist.mjs`
都在做这个真实加载检查。

### 行尾不一致导致哈希核对失效

Windows 上 git 默认 `core.autocrlf=true`，检出时把 LF 转成 CRLF，于是：

```
CI 检出（GitHub runner）: LF   → lib/index.js 35964 字节
本地检出（Windows）      : CRLF → lib/index.js 36912 字节
```

同一个文件、同样的内容，**哈希不同**。我一度据此以为发布包被污染而花时间排查；
它还会让"本地打包 == CI 打包"这个有用的断言永远为假。

**修法**：加 `.gitattributes`，显式 `* text=auto eol=lf` 并给各类文件钉死 LF，
二进制类型标 `binary`。让每种平台检出的字节一致。

