/**
 * 元自测：守卫脚本自己不许依赖管道子进程
 * ============================================================================
 *
 * 为什么需要这个：
 *   "验证脚本在受限环境假失败"这个坑在本项目里**已经犯过两次**：
 *     - v0.2.3 修掉 P1/P2（verify-all / verify-dist）
 *     - v0.2.4 新增 verify-reproducible 时又带回来了
 *   每次都是同一个形状：`spawnSync` / `execFileSync` 用**管道**接子进程输出，
 *   受限环境（沙箱、企业策略、加固的 CI 镜像）禁止打开管道 → EPERM →
 *   代码把它当成"子脚本失败"或"这个 exe 不存在" → 假失败 + 误导性报错。
 *
 *   靠人记着不管用（已经忘过一次），所以扫源码自动查。
 *
 * 判定规则：
 *   凡是用 `spawnSync` / `spawn` / `execFileSync` / `execSync` 且 stdio 含 pipe 的
 *   调用点，必须**落在白名单里**，并且白名单里每一处都要能说出"为什么这里允许"。
 *   白名单之外出现新的管道调用 → 报 FAIL，并提示改法（重定向到临时文件，
 *   或用 stdio:'inherit'，或干脆不开子进程）。
 *
 * 跑法：node scripts/verify-no-pipe-deps.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SCRIPTS = join(HERE)

let failures = 0
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => {
  failures++
  console.log(`  FAIL ${m}`)
}
const note = (m) => console.log(`  --   ${m}`)

/**
 * 白名单：允许用管道接子进程输出的地方。
 *
 * 每一项都必须能说清"为什么这里安全"。规则：
 *   - 只用于**本地开发**、不进验证链路的脚本可以放行；
 *   - 进验证链路（CI / README 清单）的脚本**一律不许**用管道，除非有 EPERM 降级。
 *
 * 空着不是偷懒 —— 这条断言存在的意义就是让"加一个新的管道调用"必须过一道人眼。
 */
const ALLOWED_PIPE_USERS = new Map([
  // 目前没有任何一个是理直气壮该用管道的。如果将来有，在这里写清理由。
])

/** 已知有 EPERM 降级、因此可以碰管道的文件（降级必须先于管道失败生效） */
const HAS_EPERM_FALLBACK = new Set([
  // verify-all.mjs 在捕获到"没拿到任何输出"时会用 stdio:'inherit' 重跑
  'verify-all.mjs',
])

console.log('\n[1] 扫描 scripts/ 下的子进程调用')
const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'))
const offenders = []
const scanned = []

for (const f of files) {
  // 注入器与检查器自己当然会提及 spawn —— 跳过它们自身
  if (f === '_inject-nopipe.mjs' || f === basename(fileURLToPath(import.meta.url))) continue

  const src = readFileSync(join(SCRIPTS, f), 'utf8')
  const lines = src.split('\n')
  let found = 0

  lines.forEach((line, i) => {
    // 只看真正的调用，不看注释
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (!/\b(spawnSync|spawn|execFileSync|execSync)\s*\(/.test(line)) return
    found++
    // 判断这次调用附近有没有管道
    const window = lines.slice(i, Math.min(lines.length, i + 12)).join('\n')
    const hasPipe = /stdio\s*:\s*(['"]pipe['"]|\[[^\]]*['"]pipe['"])/.test(window) || /encoding\s*:/.test(window)
    if (!hasPipe) return
    if (ALLOWED_PIPE_USERS.has(f)) return
    offenders.push({ file: f, line: i + 1, text: t, hasFallback: HAS_EPERM_FALLBACK.has(f) })
  })

  if (found > 0) scanned.push(`${f}(${found})`)
}

note(`扫描了 ${files.length} 个文件，其中 ${scanned.length} 个含子进程调用`)
if (scanned.length) note(`  ${scanned.join(', ')}`)
note(`白名单：${ALLOWED_PIPE_USERS.size} 项`)
note(`有 EPERM 降级的文件：${[...HAS_EPERM_FALLBACK].join(', ') || '(无)'}`)

console.log('\n[2] 断言：没有未登记的管道用法')
for (const o of offenders) {
  if (o.hasFallback) {
    note(`${o.file}:${o.line} 用管道，但该文件有 EPERM 降级 —— 放行`)
  } else {
    bad(`${o.file}:${o.line} 用管道接子进程输出，且该文件没有 EPERM 降级`)
    console.log(`         ${o.text}`)
    console.log('         改法三选一：')
    console.log('           a) stdio 重定向到临时文件（最稳，直接绕过管道限制）')
    console.log("           b) stdio: 'inherit' + 用退出码判定")
    console.log('           c) 干脆不开子进程（例如自己解析归档，见 _archive.mjs）')
    console.log('         真的必须用管道就把该文件加进 HAS_EPERM_FALLBACK，并在代码里写清降级路径。')
  }
}
if (offenders.length === 0) ok('没有未登记的管道用法')

console.log('\n[3] 断言：注入器必须覆盖数组形式的 stdio')
// 注入器自己漏掉过数组形式（['ignore','pipe','ignore']），导致它"声称禁止了管道、
// 实际没禁"，依赖它的守卫于是给出假绿。这里钉死它必须处理三种写法。
const inj = readFileSync(join(SCRIPTS, '_inject-nopipe.mjs'), 'utf8')
if (/Array\.isArray\(stdio\)/.test(inj) && /includes\(['"]pipe['"]\)/.test(inj)) {
  ok('注入器用 Array.isArray + includes 覆盖了数组形式的 stdio')
} else {
  bad('注入器没有正确处理数组形式的 stdio（[..., "pipe", ...]）—— 会给出假绿')
}

console.log('')
if (failures === 0) {
  console.log('结果：全部通过 ✅\n')
  process.exit(0)
} else {
  console.log(`结果：${failures} 项失败 ❌\n`)
  process.exit(1)
}
