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

### v0.2.5：同一个坑犯了第二次 —— 而且守卫本身没人跑

**症状**：`verify-reproducible.mjs`（v0.2.4 新增，用来守 N1 的）在禁止管道的环境里报

```
[1] 盘点本机可用的 PowerShell 版本
  FAIL 一个 PowerShell 都没找到 —— 无法验证打包可复现性
```

**它说错了原因**：本机确实装着 PowerShell 7.6.6，真因是环境禁止管道子进程。
这比假失败更糟 —— 会把人引去装一个已经装好的东西。

**根因**：`probe()` 用 `spawnSync(..., { stdio: ['ignore','pipe','ignore'] })` 接输出。
受限环境里这返回 `{status:null, error:EPERM}`，而代码 `catch` 后一律返回 null，
于是 6 个候选全被判为"不存在"。同一文件里调 `write-json.ps1` 也用了
`['ignore','pipe','pipe']`，同样会挂。

**这是 v0.2.3 刚修掉的 P1/P2 的同一类 bug**，项目甚至为此写了 `_inject-nopipe.mjs`
专门防它（`verify-all.mjs` 有 EPERM 降级、`verify-dist.mjs` 干脆不开子进程）——
但 v0.2.4 新增的那个文件又带回来了。

**修法**：不用降级，而是**绕过** —— 把 stdout/stderr 重定向到临时文件
（`stdio: ['ignore', fd, 'ignore']`），文件不受"禁止管道"的限制。
实测在注入故障的环境下，两个 PowerShell 都被正常探测到，**检查真的执行了**，
不是跳过。同时 EPERM 若仍发生（其他原因），报「本环境禁止启动子进程（EPERM）」，
明确区别于"没找到 PowerShell"。

### 真正的元问题：守卫没人跑

`verify-reproducible.mjs` 既不在 CI 的验证步骤里，也不在 README 的验证清单里，
只在一份文档里被提过。也就是说 **N1 的回归守卫等于不存在**：

- CI（`release.yml`）只跑 `verify-all` / `verify-no-lamp-logic` / `pack.ps1` / `verify-dist`
- README 的清单只有 4 条，没有它
- 真去跑它的人会得到一个误导性的失败

**修法**：把它加进 `release.yml` 与 README 清单，并补上 `audit-boundaries.mjs`
（同样漏了）。README 里加一句「改完验证脚本记得同步 CI —— 早先就是漏了」。

> 教训：**没有接进 CI 的守卫不是守卫。** 写一个检查却没人跑，比不写更危险 ——
> 它给人一种"已经被守住了"的错觉。

### 顺带：注入器自己有个漏洞，导致它给出假绿

`_inject-nopipe.mjs` 判断"是否用管道"时只看了 `stdio === undefined` / `'pipe'`，
**漏了数组形式** `['ignore','pipe','ignore']`。于是它对这类调用直接放行，
声称"已注入故障"但实际没注入 —— 依赖它的守卫检查因此给出假绿。
R1 第一次用它复现时就没复现出来，正是这个原因。

**修法**：用 `Array.isArray(stdio) && stdio.includes('pipe')` 覆盖三种写法。
并新增 `verify-no-pipe-deps.mjs` 做**元自测**：
- 扫描 `scripts/*.mjs` 里所有 `spawnSync/spawn/execFileSync/execSync` 调用，
  凡是用管道接输出的必须在白名单里（目前白名单为空），否则 FAIL 并给出三种改法
- 断言注入器确实用 `Array.isArray` + `includes` 处理数组形式

> 这个坑在本项目已犯两次（v0.2.3、v0.2.4），靠人记着不管用，所以改成自动扫源码。

### v0.2.4：打包**不可复现** —— 下载的包没法核对

**症状**：同一个 commit，`powershell -File scripts/pack.ps1`（README 教用户跑的）
与 CI 的 `shell: pwsh` 产出**不同字节**的 zip / tgz，于是发布包的 SHA256
在本地复现不出来。想核对下载包的人会以为包被污染。

**根因**：打包链路上有两个「随 PowerShell 版本变字节」的坑，**都测过**：

| | PS 5.1 | PS 7 |
|---|---|---|
| `ConvertTo-Json` | 4 空格缩进、冒号后**两个**空格、`>` 转义成 `\u003e` | 2 空格、`>` 原样 |
| 同一对象体积 | 327 字节 | 208 字节 |
| `Compress-Archive` | zip 元数据不同 | zip 元数据不同 |

`Compress-Archive` 那个更难发现：**解压后 202 个文件内容全部相同**，
只有整包 SHA256 不同。而 `verify-dist.mjs` 当时断言的是**字段**不是**字节**，
所以本地 47/47、CI 也 47/47 —— 两边都绿，哈希却不一样。

**修法**：

1. 新增 `scripts/write-json.ps1`：把 `ConvertTo-Json` 的结果统一过一遍
   Node 的 `JSON.stringify(v, null, 2)`。`pack.ps1` 的三处序列化全部改走它。
2. 新增 `scripts/_zip.mjs`：自己写确定性 zip —— 钉死时间戳、条目顺序（按路径排序）、
   权限位、压缩等级，不写 extra field。`pack.ps1` 不再用 `Compress-Archive`。
3. `verify-dist.mjs` 新增 `[4b]`：对**打包器自己改写的那两个 package.json**
   断言**确切字节**（不是字段）。只点名这两个，不遍历全树 —— 依赖树里有手工排版的
   文件（`node-addon-api/package-support.json` 是紧凑数组，467 字节 vs 规范 500 字节），
   对第三方文件的排版提要求是错的。
4. 新增 `scripts/verify-reproducible.mjs`：盘点本机所有 PowerShell，各跑一次
   `write-json.ps1`，断言产出的字节**完全相同**且等于 Node 规范形态；
   同时断言打包脚本不再直接用 `Compress-Archive` 产出 zip。

**结果**：实测 PS 5.1 与 PS 7.6.6 打出的 zip / tgz **SHA256 完全一致**。

> 教训：**"内容正确"不等于"字节可复现"。** 行尾（`.gitattributes`）和 JSON
> 序列化是同一类坑的两个面 —— 前一个早踩过并留了注释，后一个漏了。
> 判据要盯字节，因为用户核对的就是字节。

### v0.2.4：README 教人走一条必然失败的路

**症状**：README「方式二：npm 包」让人跑
`dsh plugin --profile web add dsh-led-bridge`，但该包**从未发布到 npm**
（实测 `registry.npmjs.org/dsh-led-bridge` → 404）。照做直接失败，且不知道原因。

**修法**：方式二标题直接标**「尚未发布，现在跑必然失败」**，并说明要走这条路得先由作者
`npm publish`。同时 `dsh-beacon` 这个 npm 名已被他人占用（`dushaobindoudou`，0.0.1），
README 里列出实测可用的备选名 —— 因为改名会牵连包名、Release 文件名、
workflow artifact 名、安装目录名、以及用户 profile 里已登记的 id，越早定越便宜。

### v0.2.4：清理

- `scripts/compare-plugins.mjs` 删除。它比对 bridge 与**旧版 beacon** 的命令流，
  而那个"不一致"正是**设计上的有意变更**（`busy` 状态 → 独立的 `tools on` 命令），
  于是它永远报"不一致"；还依赖工程外的绝对路径、无人引用。属于另一个项目的验收工具，
  不属于本仓库。
- `simulate.mjs` / `compare-plugins.mjs` 里残留的 `idleTimeoutMs: 0` 清掉 ——
  插件已无此键，留着会让读代码的人以为它还在（`verify-no-lamp-logic.mjs` 只扫
  `plugin/` 源码，扫不到测试脚本）。
- 测试脚本、workflow 注释、README 里的**死版本号**（`v0.2.2` / `v0.2.0`）
  改成 `v<版本>` 占位。

### v0.2.3 修掉的一批（由一次外部审查发现）

#### 1. 验证脚本在受限环境给出**假失败**

**症状**：在禁止管道子进程的环境（受限沙箱、部分企业策略、加固的 CI 镜像）里，
`selftest.mjs` 直接跑 49/49 退出码 0、`simulate.mjs` 直接跑 28/28 退出码 0，
但 `verify-all.mjs` 却报"2 项失败"；`verify-dist.mjs` 同理有 3 项假失败。

**根因**：这两处用 `execFileSync` 拉起子进程，而它**默认用管道**接输出。
环境禁止开管道时抛 `spawnSync EPERM`，代码把它和"子脚本真的失败"混为一谈。

**修法**（两条不同路线，因为两个脚本的依赖程度不同）：

- `verify-all.mjs`：显式区分三种结果 —— 退出码 0 / 真的失败 / **环境不让开管道**。
  第三种降级成 `spawnSync(stdio:'inherit')` 重跑，靠退出码判定；连这个都不行就
  明确报"本环境无法运行此项"，而**不是报 FAIL**。
  > 关键点：把"环境不支持"报成 FAIL 会让人去查不存在的 bug。
- `verify-dist.mjs`：**根本不开子进程**。zip 用解析中央目录、tgz 用
  `zlib.gunzipSync` + 解析 tar 头（见 `scripts/_archive.mjs`），产物 smoke test 改成
  动态 `import()`。依赖消失了，就不存在"环境不允许所以跳过"。

**怎么验证修好了**：我自己的开发环境**允许**管道，所以那条降级分支从没被触发过 ——
"没被跑过的容错代码等于没写"。于是加了 `scripts/_inject-nopipe.mjs`：一个 loader，
把 `execFileSync` / `spawnSync(pipe)` 强制改成抛 EPERM，本地复现受限环境。

```
node --import ./scripts/_inject-nopipe.mjs scripts/verify-all.mjs    # 23/23 退出 0
node --import ./scripts/_inject-nopipe.mjs scripts/verify-dist.mjs   # 47/47 退出 0
```

并且用**真实的失败**反证降级不会掩盖问题（故意改坏 `simulate.mjs`）：
受限环境下 `verify-all` 仍报 `22 通过 1 失败` 退出码 1。

#### 2. `idleTimeoutMs` 双重实现：旋钮是假的，而且两边会打架

**症状**：把插件配置里的 `idleTimeoutMs` 设成 `0`（本意"永不自动灭"）或任何
≥300000 的值**都不生效** —— 固件照样在 5 分钟时把灯全灭。

**根因**：同一件事有两份实现 —— 插件的 `idleTimeoutMs`（默认 300000）
与固件的 `STALE_TIMEOUT_MS = 300000UL`（`.ino:131`，在 `.ino:480` 执行）。
固件那份是**无条件**的，所以插件那份的配置值毫无作用。

而且两者**语义还不一样**，于是会互相打架：

| | 什么时候重新武装 | 实际测的是 |
|---|---|---|
| 插件 | 只在 `#dispatch` / `#reportTools` | 多久没有**新状态** |
| 固件 | 每条**被接受的**命令 | 多久没有**串口活动** |

一次很长的推理（例如压缩上下文，`thinking` 持续几分钟，中间只有不发命令的
`step/start` 事件）会先触发**插件**那个定时器，把**正在工作**的灯灭掉。

**文档还三处口径不一**：`README.md` 一边说「插件配置里没有任何灯效时长参数」，
一边又给 `idleTimeoutMs` 的配置例子；`audit-boundaries.mjs` 又把它白名单放行。

**修法**：**删掉插件那一份**，固件独占。

理由是固件那份更安全：它不会被长推理误触发，而且它是**真的**兜底
（电脑崩了、插件挂了，板子自己会灭灯）；插件那份只会误灭，兜不了任何东西。
代价是改超时要重烧固件 —— 但这个值极少改。

> 另一种方案是让插件把超时值下发给固件（保住电脑端旋钮），但那要改串口协议 +
> 重烧固件，而"让旋钮生效"这件事本身就要先重烧一次，不划算。

**怎么防止回归**：`audit-boundaries.mjs` 与 `selftest.mjs` 各加断言 ——
插件里**不许**再出现 idle 相关标识符，**同时**固件必须真的持有并按它执行
（只盯一边的话，就变成"两边都有"或"两边都没有"）。`setTimeout` 上限也从 3 降到 2。

#### 3. 升级不清理旧安装位置

**症状**：v0.2.2 之前所有 profile 共用一个 `~/.dsh/plugins/<插件名>`；v0.2.2 改成
带 profile 后缀之后，老用户升级会留下一个没人引用的孤儿目录。

**修法**：`install-dist.ps1` 装完检测旧位置并**提示**（不自动删 —— 那个目录按设计
是共享的，别的 profile 可能还链着它）。同时明确说没有残留时打印
"no leftover install from the older layout"。

#### 4. 仓库里留着一个坏脚本

`scripts/flash-and-restart.ps1` 硬编码了 `C:\Users\Rrt\.dsh\plugins\dsh-led-bridge`
（还往插件目录写临时探测文件），功能与 `build.ps1 -Upload` 重叠。本地早先删过，
但那一版已经推上去了，仓库里还留着。**已删除**。

**教训**：删了本地文件不等于删了仓库文件。清理类操作要回头看远端。

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

