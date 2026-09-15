/**
 * 产物验证：检查 dist/ 里的东西是否真的能用来安装
 * ============================================================================
 *
 * 为什么必须有这个：`pack.ps1` 里任何一步静默走偏（少复制了文件、npm 装成了
 * 不含 node_modules、tarball 里混进了脏东西），表面上都"打包成功"，
 * 但用户装上去就不工作。所以发布前必须逐项断言。
 *
 * 它检查（全部只读）：
 *   1. dist/ 结构齐全：自包含目录、zip、tgz、SHA256SUMS.txt
 *   2. 自包含目录里 plugin/package.json 【没有 dependencies】
 *      —— 这是"零配置安装"的前提（有依赖就会触发 allowBuilds 门槛）
 *   3. 自带依赖树完整：serialport 在、且至少有一个 .node 预编译绑定
 *   4. 自带 bindings-cpp 的构建标记已剥离（gypfile / scripts）
 *   5. install.ps1 是纯 ASCII（PS 5.1 会把无 BOM 的非 ASCII .ps1 解成乱码）
 *   6. zip 里的顶层目录名正确，且含 install.ps1 / plugin / LICENSE
 *   7. tgz 内容只含该发的文件（lib / cordis.patch.yml / package.json / README / LICENSE）
 *   8. 所有产物的 plugin/lib/index.js 与源码 SHA256 一致（打包没改代码）
 *   9. 真跑一次插件 apply()，确认产物可用
 *
 * 跑法：node scripts/verify-dist.mjs
 *
 * 关于"不开子进程"：
 *   早先读 zip / tgz 内容用的是 `execFileSync('tar', ...)`。在禁止管道子进程的环境里
 *   （受限沙箱、加固的 CI 镜像）这会抛 EPERM，把三项检查误报成 FAIL —— 产物其实是好的。
 *   现在改用 `_archive.mjs`（纯 JS 解析 zip 中央目录 / tar 头）+ 动态 `import()`，
 *   一个子进程都不开，所以在这个脚本里不存在"环境不允许所以跳过"这种事。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { listZip, listTarGz, readTarGzText } from './_archive.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIST = join(ROOT, 'dist')
const SRC_INDEX = join(ROOT, 'plugin', 'lib', 'index.js')
const PKG_DIR = join(DIST, 'dsh-led-bridge')
const VENDOR = join(PKG_DIR, 'plugin')

let pass = 0
let fail = 0
const ok = (label, extra = '') => {
  pass++
  console.log(`  ok   ${label}${extra ? '  — ' + extra : ''}`)
}
const bad = (label, extra = '') => {
  fail++
  console.log(`  FAIL ${label}${extra ? '  — ' + extra : ''}`)
}
const check = (label, cond, extra = '') => (cond ? ok(label, extra) : bad(label, extra))

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').toUpperCase()

// ---------------------------------------------------------------------------
console.log('\n[1] dist/ 结构')
// ---------------------------------------------------------------------------
if (!existsSync(DIST)) {
  console.log(`  FAIL dist/ 不存在：${DIST}`)
  console.log('\n  先跑：powershell -ExecutionPolicy Bypass -File scripts\\pack.ps1\n')
  process.exit(1)
}
check('dist/ 存在', true)

const version = JSON.parse(readFileSync(join(ROOT, 'plugin', 'package.json'), 'utf8')).version
const ZIP = join(DIST, `dsh-led-bridge-${version}.zip`)
const TGZ = join(DIST, `dsh-led-bridge-${version}.tgz`)

check('自包含目录 dist/dsh-led-bridge/', existsSync(PKG_DIR))
check('安装脚本 install.ps1', existsSync(join(PKG_DIR, 'install.ps1')))
check('LICENSE', existsSync(join(PKG_DIR, 'LICENSE')))
check('DISTRIBUTION.md', existsSync(join(PKG_DIR, 'DISTRIBUTION.md')))
check(`zip（dsh-led-bridge-${version}.zip）`, existsSync(ZIP))
check(`tgz（dsh-led-bridge-${version}.tgz）`, existsSync(TGZ))
check('SHA256SUMS.txt', existsSync(join(DIST, 'SHA256SUMS.txt')))

if (!existsSync(VENDOR)) {
  console.log('\n  产物不完整，后续检查跳过。\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
console.log('\n[2] 自包含目录：零配置安装的前提')
// ---------------------------------------------------------------------------
const vendorPkg = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8'))

check(
  'plugin/package.json 没有 dependencies（有依赖就会触发 allowBuilds 门槛）',
  vendorPkg.dependencies === undefined,
  vendorPkg.dependencies ? '发现: ' + JSON.stringify(vendorPkg.dependencies) : '无',
)
check('包名正确', vendorPkg.name === 'dsh-led-bridge', vendorPkg.name)
check('版本正确', vendorPkg.version === version, vendorPkg.version)
check(
  'dsh.bundle.patch 指向 cordis.patch.yml',
  vendorPkg.dsh?.bundle?.patch === './cordis.patch.yml',
  vendorPkg.dsh?.bundle?.patch,
)
check('cordis.patch.yml 在', existsSync(join(VENDOR, 'cordis.patch.yml')))

// 残留的 pnpm 文件会破坏安装
for (const junk of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
  check(`没有 pnpm 残留 ${junk}`, !existsSync(join(VENDOR, junk)))
}
check('没有 .package-lock.json 残留', !existsSync(join(VENDOR, 'node_modules', '.package-lock.json')))

// ---------------------------------------------------------------------------
console.log('\n[3] 自带依赖树')
// ---------------------------------------------------------------------------
const NM = join(VENDOR, 'node_modules')
check('node_modules/serialport 在', existsSync(join(NM, 'serialport')))

const nodeFiles = []
const walk = (d) => {
  for (const ent of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, ent.name)
    if (ent.isDirectory()) walk(p)
    else if (ent.name.endsWith('.node')) nodeFiles.push(p)
  }
}
if (existsSync(NM)) walk(NM)

check('至少有一个预编译 .node 绑定', nodeFiles.length > 0, `${nodeFiles.length} 个`)
check(
  '含 win32-x64 绑定（本机平台）',
  nodeFiles.some((p) => p.includes('win32-x64')),
)
check(
  '含 linux-x64 绑定（跨平台）',
  nodeFiles.some((p) => p.includes('linux-x64')),
)

// 构建标记必须已剥离，否则 pnpm 可能又想构建
const bcPath = join(NM, '@serialport', 'bindings-cpp', 'package.json')
if (existsSync(bcPath)) {
  const bc = JSON.parse(readFileSync(bcPath, 'utf8'))
  check('bindings-cpp 已剥离 gypfile', bc.gypfile === undefined, String(bc.gypfile))
  check('bindings-cpp 已剥离 scripts', bc.scripts === undefined)
  check('bindings-cpp 已剥离 devDependencies', bc.devDependencies === undefined)
} else {
  bad('找到 @serialport/bindings-cpp/package.json')
}

// ---------------------------------------------------------------------------
console.log('\n[4] install.ps1 必须是纯 ASCII')
// ---------------------------------------------------------------------------
const inst = readFileSync(join(PKG_DIR, 'install.ps1'))
const nonAscii = []
for (let i = 0; i < inst.length; i++) if (inst[i] > 0x7f) nonAscii.push(i)
check(
  'install.ps1 全部为 ASCII（PS 5.1 会把无 BOM 的非 ASCII .ps1 解成乱码）',
  nonAscii.length === 0,
  nonAscii.length ? `${nonAscii.length} 个非 ASCII 字节，首个在偏移 ${nonAscii[0]}` : '',
)

// ---------------------------------------------------------------------------
console.log('\n[4b] 产物里的 JSON 必须是「固定序列化」的字节')
// ---------------------------------------------------------------------------
// 为什么断言**字节**而不只是字段：
//   `ConvertTo-Json` 的输出随 PowerShell 版本变（PS 5.1 用 4 空格缩进、
//   冒号后两个空格、把 ">" 转义成 \u003e；PS 7 用 2 空格）。内容等价，
//   **字节不同** —— 于是本地打包与 CI 打包的 SHA256 对不上，想核对下载包的人
//   会以为包被污染。
//   只断言字段的话查不出这个问题（本地 47/47、CI 也 47/47，但两者哈希不同）。
//
// 规范形态 = Node 的 JSON.stringify(value, null, 2) + 末尾换行 —— 正是
// scripts/write-json.ps1 产出、scripts/verify-reproducible.mjs 跨版本验证过的东西。
//
// 只盯 pack.ps1 **自己改写**的那两个文件，不遍历所有 JSON：
// 依赖树里有些文件本来就**不是**规范排版，例如 node-addon-api 的
// package-support.json 是手工格式化过的（数组元素紧凑排列，467 字节 vs 规范化的
// 500 字节）。对第三方文件的排版提要求是错的，所以逐个点名而不是全扫。
const GENERATED_JSON = [
  join(VENDOR, 'package.json'),
  join(VENDOR, 'node_modules', '@serialport', 'bindings-cpp', 'package.json'),
]

for (const p of GENERATED_JSON) {
  const label = p.replace(VENDOR + '\\', 'plugin\\').replace(VENDOR + '/', 'plugin/')
  if (!existsSync(p)) {
    bad(`${label} 不存在（打包器本该改写它）`)
    continue
  }
  const text = readFileSync(p, 'utf8')
  let canonical
  try {
    canonical = JSON.stringify(JSON.parse(text), null, 2) + '\n'
  } catch (e) {
    bad(`${label} 不是合法 JSON：${e.message}`)
    continue
  }
  const why =
    text === canonical
      ? ''
      : /\n {4}"/.test(text)
        ? '4 空格缩进（PS 5.1 的 ConvertTo-Json 形态）'
        : text.includes('\\u003e')
          ? '含 \\u003e 转义（PS 5.1 的 ConvertTo-Json 形态）'
          : '与规范形态不同'
  check(`${label} 是固定序列化字节（跨 PowerShell 版本可复现）`, why === '', why || `${text.length} 字节`)
}

// ---------------------------------------------------------------------------
console.log('\n[5] zip 内容')
// ---------------------------------------------------------------------------
if (existsSync(ZIP)) {
  let entries = null
  try {
    // 纯 JS 读中央目录，不开子进程
    entries = listZip(ZIP)
  } catch (e) {
    bad('读取 zip 内容失败', e.message)
  }
  if (entries) {
    // Compress-Archive -LiteralPath <folder> 会带上顶层目录名
    const rel = entries.map((e) => e.replace(/^dsh-led-bridge\//, ''))
    check('zip 有顶层目录 dsh-led-bridge/', entries.some((e) => e.startsWith('dsh-led-bridge/')), `${entries.length} 项`)
    check('zip 含 install.ps1', rel.includes('install.ps1'))
    check('zip 含 LICENSE', rel.includes('LICENSE'))
    check('zip 含 plugin/package.json', rel.includes('plugin/package.json'))
    check('zip 含 plugin/cordis.patch.yml', rel.includes('plugin/cordis.patch.yml'))
    check('zip 含 plugin/lib/index.js', rel.includes('plugin/lib/index.js'))
    check(
      'zip 含自带依赖 node_modules/serialport',
      rel.some((e) => e.startsWith('plugin/node_modules/serialport/')),
    )
    check(
      'zip 含预编译绑定',
      rel.some((e) => e.endsWith('.node')),
      `${rel.filter((e) => e.endsWith('.node')).length} 个 .node`,
    )
    check('zip 不含 pnpm 残留', !rel.some((e) => /pnpm-(lock|workspace)\.yaml/.test(e) || /pnpm-lock\.yaml/.test(e)))
  }
} else {
  bad('zip 不存在，跳过')
}

// ---------------------------------------------------------------------------
console.log('\n[6] tgz 内容')
// ---------------------------------------------------------------------------
if (existsSync(TGZ)) {
  let rawEntries = null
  try {
    // 纯 JS 解析 tar 头，不开子进程
    rawEntries = listTarGz(TGZ).filter((e) => e.type !== '5').map((e) => e.name)
  } catch (e) {
    bad('读取 tgz 内容失败', e.message)
  }
  if (rawEntries) {
    const entries = rawEntries.map((e) => e.replace(/^package\//, '').replace(/\/$/, '')).filter(Boolean)
    const allowed = new Set(['lib/index.js', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE'])
    check('tgz 含 lib/index.js', entries.includes('lib/index.js'))
    check('tgz 含 cordis.patch.yml', entries.includes('cordis.patch.yml'))
    check('tgz 含 package.json', entries.includes('package.json'))
    check('tgz 含 LICENSE', entries.includes('LICENSE'))
    const unexpected = entries.filter((e) => !allowed.has(e))
    check('tgz 没有多余文件', unexpected.length === 0, unexpected.slice(0, 8).join(', '))
    check(
      'tgz 不含 node_modules（没有自带依赖树，只能靠依赖声明去拉）',
      !entries.some((e) => e.includes('node_modules')),
    )

    // ---- tgz 必须是 npm 能接受的 tar ----
    //
    // 这条守的是一个**只有 npm 会报**的 bug：我们自己写 tar（为了字节可复现），
    // 曾经把 `ustar` magic 写到偏移 157（那是 linkname 字段）而不是 257。
    // 后果：magic 全零 → npm 的解析器退回 GNU tar 语义 → 空 linkname 被判成
    // "linkpath forbidden"，整个包 `TAR_BAD_ARCHIVE` 装不上。
    // 而**系统 tar 与 Node 自己的解析器都不在意**，所以只有真跑 npm install 才会现形。
    //
    // 这里直接校验 tar 头规范要求的字段，比"跑一遍 npm install"快得多，
    // 也正好覆盖那个失败模式。
    try {
      const head = gunzipSync(readFileSync(TGZ)).subarray(0, 512)
      const magic = head.subarray(257, 263).toString('utf8')
      check('tgz 第一个 tar 头的 magic 是 ustar（在偏移 257）', magic === 'ustar\0', JSON.stringify(magic))
      const ver = head.subarray(263, 265).toString('utf8')
      check('tgz tar 头的 version 是 00', ver === '00', JSON.stringify(ver))
      // 校验和字段必须自洽（否则 npm 会报 TAR_ENTRY_INVALID checksum failure）
      const tmp = Buffer.from(head)
      const stored = tmp.subarray(148, 156).toString('utf8')
      for (let i = 148; i < 156; i++) tmp[i] = 32
      let sum = 0
      for (let i = 0; i < 512; i++) sum += tmp[i]
      check(
        'tgz tar 头校验和自洽',
        stored.startsWith(sum.toString(8).padStart(6, '0')),
        `写入 ${JSON.stringify(stored)} 实测 ${sum.toString(8)}`,
      )
      const typeflag = head.subarray(156, 157).toString('utf8')
      check('tgz 第一个条目是普通文件（typeflag 0）', typeflag === '0', JSON.stringify(typeflag))
    } catch (e) {
      bad('无法读取 tgz 的 tar 头', e.message)
    }

    // ---- 关键断言：tarball 必须声明依赖 ----
    //
    // 这是 v0.2.0 真实发布过的 bug：tarball 从"剥掉 dependencies 的 vendor 副本"
    // 打包，于是它既带不了 node_modules（pnpm pack 永远排除）、又没声明依赖，
    // 结果 `dsh plugin add` 成功、插件却解析不到 serialport，
    // 运行时静默降级成"串口不可用" —— 安装看起来完全正常。
    //
    // 两种形态在这一点上是相反的，必须分别断言：
    //   自包含目录 → 无 dependencies（依赖树就在旁边，声明了反而触发 allowBuilds）
    //   tarball   → 有 dependencies（没有依赖树，只能靠声明去拉）
    try {
      const tgzPkg = JSON.parse(readTarGzText(TGZ, 'package/package.json'))
      check(
        'tgz 声明了 serialport 依赖（否则装了也解析不到原生绑定）',
        tgzPkg.dependencies?.serialport !== undefined,
        tgzPkg.dependencies ? JSON.stringify(tgzPkg.dependencies) : '没有 dependencies 字段',
      )
      check(
        'tgz 的包名与自包含目录一致',
        tgzPkg.name === vendorPkg.name,
        `${tgzPkg.name} vs ${vendorPkg.name}`,
      )
      check('tgz 的版本与自包含目录一致', tgzPkg.version === vendorPkg.version, `${tgzPkg.version} vs ${vendorPkg.version}`)
    } catch (e) {
      bad('无法读取 tgz 内的 package.json', e.message)
    }
  }
} else {
  bad('tgz 不存在，跳过')
}

// ---------------------------------------------------------------------------
console.log('\n[7] 产物里的插件代码 = 源码（打包没改代码）')
// ---------------------------------------------------------------------------
const srcHash = sha256(SRC_INDEX)
const vendorIndex = join(VENDOR, 'lib', 'index.js')
if (existsSync(vendorIndex)) {
  const h = sha256(vendorIndex)
  check('自包含目录的 lib/index.js 与源码一致', h === srcHash, h.slice(0, 16) + '…')
} else {
  bad('自包含目录缺 lib/index.js')
}

// ---------------------------------------------------------------------------
console.log('\n[8] 真跑一次产物的 apply()')
// ---------------------------------------------------------------------------
// 用动态 import() 在当前进程里加载产物，不再开子进程（原因见文件头）。
// 这样连"环境不让开子进程"这个失败模式都不存在了。
if (existsSync(vendorIndex)) {
  try {
    const mod = await import(pathToFileURL(vendorIndex).href)
    const listeners = []
    const ctx = {
      logger: { info() {} },
      on(ev) {
        listeners.push(ev)
        return () => {}
      },
    }
    const dispose = mod.apply(ctx, { port: 'COM_NOT_REAL', reconnectIntervalMs: 999999 })
    const problems = []
    if (mod.name !== 'dsh-led-bridge') problems.push(`name=${mod.name}`)
    if (listeners.length !== 1 || listeners[0] !== 'session/event') problems.push(`listeners=${listeners.join('|')}`)
    if (typeof dispose !== 'function') problems.push('dispose 不是函数')
    if (typeof dispose === 'function') dispose()

    check(
      '产物插件可加载并正常 apply/dispose',
      problems.length === 0,
      problems.length ? problems.join('; ') : 'name/listeners/dispose 都正确',
    )
  } catch (e) {
    bad('产物插件加载失败', (e && e.message ? e.message : String(e)).slice(0, 300))
  }
} else {
  bad('缺 lib/index.js，跳过 smoke test')
}

// ---------------------------------------------------------------------------
console.log('\n[9] 校验和文件')
// ---------------------------------------------------------------------------
const sumsPath = join(DIST, 'SHA256SUMS.txt')
if (existsSync(sumsPath)) {
  const lines = readFileSync(sumsPath, 'utf8').split('\n').filter(Boolean)
  check('SHA256SUMS.txt 有两行（zip + tgz）', lines.length === 2, `${lines.length} 行`)
  for (const line of lines) {
    const m = /^([0-9A-Fa-f]{64})\s+(.+)$/.exec(line.trim())
    if (!m) {
      bad(`校验和行格式不对: ${line}`)
      continue
    }
    const [, hash, fname] = m
    const p = join(DIST, fname)
    if (!existsSync(p)) {
      bad(`${fname} 在 dist/ 里不存在`)
      continue
    }
    check(`${fname} 校验和匹配`, sha256(p) === hash.toUpperCase())
  }
} else {
  bad('SHA256SUMS.txt 不存在')
}

// ---------------------------------------------------------------------------
console.log(`\n结果：${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
