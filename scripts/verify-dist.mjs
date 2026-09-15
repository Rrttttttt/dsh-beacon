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
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

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
console.log('\n[5] zip 内容')
// ---------------------------------------------------------------------------
if (existsSync(ZIP)) {
  // 用 tar 列 zip 内容（Windows 10+ 自带 bsdtar，能读 zip）
  let listing = ''
  try {
    listing = execFileSync('tar', ['-tf', ZIP], { encoding: 'utf8' })
  } catch (e) {
    bad('读取 zip 内容失败', e.message)
  }
  if (listing) {
    // bsdtar on Windows prints backslash separators; normalise before matching.
    const entries = listing
      .split('\n')
      .map((s) => s.trim().replace(/\\/g, '/'))
      .filter(Boolean)
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
  let listing = ''
  try {
    listing = execFileSync('tar', ['-tzf', TGZ], { encoding: 'utf8' })
  } catch (e) {
    bad('读取 tgz 内容失败', e.message)
  }
  if (listing) {
    const entries = listing
      .split('\n')
      .map((s) => s.trim().replace(/\\/g, '/').replace(/^package\//, '').replace(/\/$/, ''))
      .filter(Boolean)
    const allowed = new Set(['lib/index.js', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE'])
    check('tgz 含 lib/index.js', entries.includes('lib/index.js'))
    check('tgz 含 cordis.patch.yml', entries.includes('cordis.patch.yml'))
    check('tgz 含 package.json', entries.includes('package.json'))
    check('tgz 含 LICENSE', entries.includes('LICENSE'))
    const unexpected = entries.filter((e) => !allowed.has(e))
    check('tgz 没有多余文件', unexpected.length === 0, unexpected.slice(0, 8).join(', '))
    check(
      'tgz 不含 node_modules（pnpm pack 永远排除，故 tgz 装不了自带依赖）',
      !entries.some((e) => e.includes('node_modules')),
    )
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
if (existsSync(vendorIndex)) {
  const script = `
import { apply, name } from './lib/index.js'
const listeners = []
const ctx = { logger: { info() {} }, on(ev, h) { listeners.push(ev); return () => {} } }
const dispose = apply(ctx, { port: 'COM_NOT_REAL', reconnectIntervalMs: 999999 })
if (name !== 'dsh-led-bridge') { console.log('BAD name: ' + name); process.exit(1) }
if (listeners.length !== 1 || listeners[0] !== 'session/event') { console.log('BAD listeners'); process.exit(1) }
if (typeof dispose !== 'function') { console.log('BAD dispose'); process.exit(1) }
dispose()
console.log('SMOKE_OK')
`
  try {
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: VENDOR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    check('产物插件可加载并正常 apply/dispose', out.includes('SMOKE_OK'), out.trim().split('\n').pop())
  } catch (e) {
    bad('产物插件加载失败', (e.stderr || e.message || '').toString().trim().slice(0, 300))
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
