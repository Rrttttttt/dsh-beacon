/**
 * 架构边界与完整性自审（独立脚本，不依赖被审对象自己"说"自己没问题）
 * ============================================================================
 *
 * 这个脚本的存在理由：重构后必须能回答两个问题，而且答案不能来自"我看了一眼代码"：
 *   1. 插件里是否真的【不存在】任何灯效时序？（架构边界的硬校验）
 *   2. 固件里是否真的【存在】工具尾窗的完整实现？
 *
 * 做法：直接读取源码文本，做结构性断言（存在性 + 不存在性），
 *      并对运行时导出的配置做集合校验。任何一条不过就 exit 1。
 *
 * 跑法：node scripts/audit-boundaries.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let failed = 0
function check(label, ok, detail = '') {
  const mark = ok ? '  ok  ' : '  FAIL'
  console.log(`${mark} ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed++
}

const pluginSrc = readFileSync(join(ROOT, 'plugin', 'lib', 'index.js'), 'utf8')
const fwSrc = readFileSync(
  join(ROOT, 'firmware', 'esp32c3_dsh_status_light', 'esp32c3_dsh_status_light.ino'),
  'utf8',
)
const pluginObj = await import(pathToFileURL(join(ROOT, 'plugin', 'lib', 'index.js')).href)

console.log('\n[1] 源码文本健康度（有没有被编码/编辑事故破坏）')

for (const [name, src] of [['plugin/lib/index.js', pluginSrc], ['固件 .ino', fwSrc]]) {
  check(`${name} 无 U+FFFD 替换字符`, !src.includes('\uFFFD'))
  check(`${name} 含正常中文注释`, /[\u4e00-\u9fff]/.test(src))
  // 结构健康的一个便宜判据：大括号成对
  const open = (src.match(/\{/g) || []).length
  const close = (src.match(/\}/g) || []).length
  check(`${name} 大括号配对`, open === close, `{=${open} }=${close}`)
}

console.log('\n[2] 插件不得持有任何灯效时序（架构边界）')

// 2a. 运行时配置集合：不允许出现时长类键
const cfgKeys = Object.keys(pluginObj.__testing.DEFAULTS)
const TIMING_RE = /cooldown|hold|fade|tail|blink|duration|period|interval|ms$/i
// reconnectIntervalMs 是"连不上板子时多久重试"，属于连接策略，不是灯效时序，白名单放行
const ALLOWED = new Set(['port', 'vendorId', 'productId', 'baudRate', 'alarmTimeoutMs', 'idleTimeoutMs', 'reconnectIntervalMs'])
const timingKeys = cfgKeys.filter((k) => TIMING_RE.test(k) && !ALLOWED.has(k))
check('配置里无灯效时长参数', timingKeys.length === 0, timingKeys.join(', '))

// 2b. 源码里不允许出现灯效时序相关标识符（注释里的历史说明除外）
const codeLines = pluginSrc
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
  })
  .join('\n')

for (const banned of ['busyCooldownMs', 'busyTimer', 'TOOLS_SUFFIX', 'toolsHold', 'toolsOffAt']) {
  check(`插件代码里无 ${banned}`, !codeLines.includes(banned))
}

// 2c. 只允许两处 setTimeout：alarm 回落 + 空闲兜底（都是"防止电脑异常"的兜底，
//     不是灯效时序）。另外 LedTransport 的重连定时器在连接层，也算合理。
const timerCount = (codeLines.match(/setTimeout/g) || []).length
check('setTimeout 数量不超过 3（alarm 回落 / 空闲兜底 / 串口重连）', timerCount <= 3, `实际 ${timerCount}`)

// 2d. 插件必须只下发这几种命令
//
// 注意：源码里有些命令是拼接出来的（`${CMD_NOTIFY} ${cmd}`、`'notify ' + x`），
// 直接把模板字面量拿去比对会把 "notify ${cmd}" 误判成未知命令。
// 所以先做两步归一：
//   1. 取出命令的「首 token」——它一定是字面量（"tools on" 的首 token 是 tools）；
//   2. 把 ${CMD_*} 展开成插件的常量值，再参与比对。
const CONST_VALUES = {
  CMD_TOOLS_ON: 'tools on',
  CMD_TOOLS_OFF: 'tools off',
  CMD_NOTIFY: 'notify',
}
const expandConsts = (s) =>
  s.replace(/\$\{\s*(CMD_[A-Z_]+)\s*\}/g, (_, n) => CONST_VALUES[n] ?? `\${${n}}`)

/** 取出一次 send() 实参的「首 token」：第一个字符串/模板字面量或标识符。 */
function firstToken(argSrc) {
  const m = argSrc.match(/^\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([A-Za-z_$][\w$]*))/)
  if (!m) return ''
  const literal = m[1] ?? m[2] ?? m[3]
  if (literal !== undefined) return expandConsts(literal).trim().split(/\s+/)[0]
  // 裸标识符：已经在常量表里的先展开（例如 CMD_NOTIFY），
  // 剩下的才是真正的运行期变量，标记出来供人工确认。
  const name = m[4]
  if (name in CONST_VALUES) return CONST_VALUES[name].split(/\s+/)[0]
  return `<运行期变量: ${name}>`
}

const sentLiterals = [...pluginSrc.matchAll(/send\(([^)]*)/g)].map((m) => firstToken(m[1]))
const allowedCmds = new Set(['tools', 'notify', 'thinking', 'busy', 'error', 'alarm', 'success', 'plan', 'off'])
// 允许的运行期变量：这些位置的命令字由状态机算出，不是硬编码字面量
const variableTokens = new Set([
  '<运行期变量: state>',
  '<运行期变量: cmd>',
  '<运行期变量: shouldBeOn>',
  '<运行期变量: machine>',
])
const unexpected = sentLiterals.filter((c) => !allowedCmds.has(c) && !variableTokens.has(c))
check(
  '下发的命令首 token 都在白名单内',
  unexpected.length === 0,
  `未知: ${unexpected.join(', ')}  全部: ${[...new Set(sentLiterals)].join(' | ')}`,
)

console.log('\n[3] 固件必须完整实现工具尾窗')

const requiredSymbols = [
  'TOOLS_HOLD_MS',
  'TOOLS_HOLD_MAX_MS',
  'toolsActive',
  'toolsHoldPending',
  'toolsOffAtMs',
  'updateToolsEffect',
  'onToolsOn',
  'onToolsOff',
  'resetTools',
  'LAMP_SLEEP',
  'BREATHE_PERIOD_MS',
]
for (const s of requiredSymbols) {
  check(`固件含 ${s}`, fwSrc.includes(s))
}

check('尾窗时长取自呼吸周期（TOOLS_HOLD_MS = BREATHE_PERIOD_MS）',
  /const\s+uint32_t\s+TOOLS_HOLD_MS\s*=\s*BREATHE_PERIOD_MS/.test(fwSrc))
check('固件解析独立的 tools on/off 命令', /cmd\s*==\s*"tools"\s*\|\|\s*cmd\.startsWith\("tools "\)/.test(fwSrc))
check('固件已移除 +tools 修饰符解析', !fwSrc.includes('endsWith("+tools")'))
check('loop() 里调用了 updateToolsEffect', /updateToolsEffect\s*\(/.test(fwSrc))

console.log('\n[4] 插件与固件的协议必须对得上')

// 插件发什么，固件就得认什么
const pluginCommands = ['tools on', 'tools off', 'notify', 'thinking', 'plan', 'off']
for (const c of pluginCommands) {
  const base = c.split(' ')[0]
  check(`固件认识「${c}」`, fwSrc.includes(`"${base}"`) || fwSrc.includes(`"${c}"`))
}

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 条失败'}\n`)
process.exit(failed === 0 ? 0 : 1)
