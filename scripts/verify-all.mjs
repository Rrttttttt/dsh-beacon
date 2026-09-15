/**
 * 插件 ↔ 固件 端到端可行性验证（一次性把能查的都查完）
 * ============================================================================
 *
 * 为什么单独做这个：前面每修一个 bug 都要跑一遍零散检查，容易漏。
 * 这个脚本把"这两个部件能不能配合工作"拆成可以直接断言的几组，一次跑完：
 *
 *   A. 静态：文件存在、语法、编码
 *   B. 单测：插件状态机（映射表 / 工具计数 / 计划模式 / 通知）
 *   C. 端到端：事件 → 插件 → 命令 → 固件移植渲染（含工具尾窗时间线）
 *   D. 协议：插件会发的每条命令，固件都必须认；固件不认的，插件不许发
 *   E. 架构：插件不含灯效时序（渲染与时间控制全在固件）
 *   F. 真机（可选，--live）：往板子发一条命令，确认它按新协议回执
 *
 * 跑法：
 *     node scripts/verify-all.mjs          # A~E，不需要板子
 *     node scripts/verify-all.mjs --live   # 外加 F，需要板子空闲
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const LIVE = process.argv.includes('--live')

let pass = 0
let fail = 0
function check(group, label, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} [${group}] ${label}${detail ? '  — ' + detail : ''}`)
  if (ok) pass++
  else fail++
}

/**
 * 跑一个子脚本，返回它的结果。
 *
 * 为什么要处理 EPERM：`execFileSync` 默认用**管道**接子进程输出。有些环境禁止
 * 打开管道（受限沙箱、部分企业策略、加固过的 CI 镜像），这时会抛
 * `spawnSync ... EPERM`。早先的实现把它和"子脚本真的失败"混为一谈 —— 直接判 FAIL。
 *
 * 实测过这个误判：在禁管道环境下，selftest.mjs 直接跑 49/49 退出码 0、
 * simulate.mjs 直接跑 28/28 退出码 0，但 verify-all 却报"2 项失败"。
 *
 * 现在分三种结果：
 *   ok: true            子脚本退出码 0
 *   ok: false           子脚本真的失败了（带 FAIL 输出）
 *   ok: false, env:true 环境不让开管道 —— 用 inherit 重跑，靠退出码判定
 *
 * 注意"环境不支持"和"检查失败"必须区分开：把前者报成 FAIL 会让人去查不存在的 bug，
 * 正是这条修正要避免的。
 *
 * @param {string} relPath 相对仓库根的脚本路径
 * @param {string} label   用于日志的短名
 */
function runNode(relPath, label) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(ROOT, relPath)], { encoding: 'utf8' }) }
  } catch (e) {
    // e.stdout / e.stderr 在"禁止管道"时是 undefined，所以要用 e.status 判断
    const piped = e.stdout !== undefined || e.stderr !== undefined
    if (piped) return { ok: false, out: (e.stdout || '') + (e.stderr || '') }

    // 没有捕获到任何输出，说明这次不是子脚本失败，而是我们没法接它的输出。
    // 降级：让子进程直接继承本进程的 stdio，靠退出码判定。
    console.log(`  --   [${label}] 无法用管道捕获输出（受限环境），改用 inherit 重跑`)
    let status = null
    let spawnErr = null
    try {
      const r = spawnSync(process.execPath, [join(ROOT, relPath)], { stdio: 'inherit' })
      status = r.status
      spawnErr = r.error || null
    } catch (err) {
      spawnErr = err
    }
    if (spawnErr) {
      return { ok: false, env: true, out: `${label} 无法在本环境运行：${spawnErr.message}` }
    }
    return { ok: status === 0, out: '' }
  }
}

console.log('\n========== A. 静态检查 ==========')
const pluginIndex = join(ROOT, 'plugin', 'lib', 'index.js')
const fwIno = join(ROOT, 'firmware', 'esp32c3_dsh_status_light', 'esp32c3_dsh_status_light.ino')
for (const [name, p] of [['plugin/lib/index.js', pluginIndex], ['固件 .ino', fwIno]]) {
  check('A', `${name} 存在`, existsSync(p))
}
const pluginSrc = readFileSync(pluginIndex, 'utf8')
const fwSrc = readFileSync(fwIno, 'utf8')
check('A', '插件无 U+FFFD 乱码', !pluginSrc.includes('\uFFFD'))
check('A', '固件无 U+FFFD 乱码', !fwSrc.includes('\uFFFD'))
check('A', '固件无 DBG 调试残留', !fwSrc.includes('DBG'))
check('A', '固件尾窗 = 一个呼吸周期', /TOOLS_HOLD_MS\s*=\s*BREATHE_PERIOD_MS/.test(fwSrc))
check('A', '固件含撤销叠加（applyStateEffects 在收尾分支）', /applyStateEffects\(currentState/.test(fwSrc))

console.log('\n========== B/C. 单元自测 + 端到端模拟 ==========')
const st = runNode('scripts/selftest.mjs', 'B')
if (st.env) {
  check('B', 'selftest.mjs 全绿', false, '本环境无法运行子进程（见上）')
} else {
  check('B', 'selftest.mjs 全绿', st.ok, st.ok ? '' : '见下方输出')
  if (!st.ok) console.log(st.out.split('\n').filter((l) => l.includes('FAIL')).join('\n'))
}
const sim = runNode('scripts/simulate.mjs', 'C')
if (sim.env) {
  check('C', 'simulate.mjs 全绿', false, '本环境无法运行子进程（见上）')
} else {
  check('C', 'simulate.mjs 全绿', sim.ok, sim.ok ? '' : '见下方输出')
  if (!sim.ok) console.log(sim.out.split('\n').filter((l) => l.includes('FAIL')).join('\n'))
}

console.log('\n========== D. 协议一致性 ==========')
const pluginObj = await import(pathToFileURL(pluginIndex).href)
const { StateMachine, DEFAULTS, CMD_NOTIFY, PLAN_SUFFIX } = pluginObj.__testing

// 让真实状态机跑一遍典型事件，收集它真正会下发的命令
const sent = []
const fakeTransport = { send: (c) => sent.push(c) }
const m = new StateMachine({ alarmTimeoutMs: 0 }, fakeTransport, () => {})
const script = [
  { type: 'turn/start' },
  { type: 'assistant/attempt' },
  { type: 'tool/call' },
  { type: 'tool/result', data: {} },
  { type: 'approval/asked', data: { id: 'a', toolName: 't' } },
  { type: 'approval/decided', data: { id: 'a', outcome: 'allow' } },
  { type: 'llm/retry' },
  { type: 'plan/mode', data: { active: true } },
  { type: 'tool/call' },
  { type: 'goal/change' },
  { type: 'plan/mode', data: { active: false } },
  { type: 'turn/end' },
  { type: 'session/end-seed' },
]
for (const ev of script) m.handle(ev)
m.dispose()

const validators = {
  state: (c) => /^(thinking|error|alarm|success|off|plan)(\+plan)?$/.test(c),
  tools: (c) => c === 'tools on' || c === 'tools off',
  notify: (c) => c === CMD_NOTIFY || c.startsWith(CMD_NOTIFY + ' '),
}
const uniq = [...new Set(sent)]
check('D', '插件下发的命令都能被归类', uniq.every((c) => validators.state(c) || validators.tools(c) || validators.notify(c)), uniq.join(' , '))

// 插件发的每一条，固件解析器都要认
const fwRecognizes = (cmd) => {
  if (cmd.startsWith('tools')) return /cmd\s*==\s*"tools"/.test(fwSrc)
  if (cmd === CMD_NOTIFY || cmd.startsWith(CMD_NOTIFY + ' ')) return /cmd\s*==\s*"notify"/.test(fwSrc)
  const base = cmd.replace(PLAN_SUFFIX, '')
  return fwSrc.includes(`"${base}"`)
}
for (const c of uniq) {
  check('D', `固件认「${c}」`, fwRecognizes(c))
}

// 反向：固件不认 +tools 了，插件也不该发
check('D', '插件不再发 +tools 形式', !uniq.some((c) => c.includes('+tools')))
check('D', '固件不再解析 +tools', !fwSrc.includes('endsWith("+tools")'))

console.log('\n========== E. 架构边界 ==========')
const timingKeys = Object.keys(DEFAULTS).filter((k) => /cooldown|hold|fade|tail|blink|duration|period/i.test(k))
check('E', '插件配置无灯效时长参数', timingKeys.length === 0, timingKeys.join(', '))
const codeOnly = pluginSrc
  .split('\n')
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join('\n')
check('E', '插件代码无工具尾窗变量', !/toolsHold|toolsOffAt|busyTimer|busyCooldown/.test(codeOnly))
check('E', '固件确实持有尾窗状态', /toolsHoldPending/.test(fwSrc) && /toolsOffAtMs/.test(fwSrc))

console.log('\n========== F. 真机（可选）==========')
if (!LIVE) {
  console.log('  -- 跳过（加 --live 才会往板子发命令）')
} else {
  const port = 'COM3'
  let SerialPort
  try {
    const req = (await import('node:module')).createRequire(join(ROOT, 'plugin', 'package.json'))
    SerialPort = (await import(pathToFileURL(req.resolve('serialport')).href)).SerialPort
  } catch {
    check('F', 'serialport 可加载', false)
  }
  if (SerialPort) {
    const sp = new SerialPort({ path: port, baudRate: 115200, autoOpen: false })
    const lines = []
    let buf = ''
    sp.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).replace(/\r/g, '').trim()
        buf = buf.slice(i + 1)
        if (l) lines.push(l)
      }
    })
    await new Promise((res, rej) => sp.open((e) => (e ? rej(e) : res())))
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ask = async (cmd) => {
      lines.length = 0
      sp.write(cmd + '\n')
      await sleep(400)
      return lines.filter((l) => l.startsWith('OK') || l.startsWith('ERR'))[0] || '(无回执)'
    }
    const a1 = await ask('tools on')
    check('F', `板子认 tools on`, a1 === 'OK tools on', a1)
    const a2 = await ask('tools off')
    check('F', `板子认 tools off`, a2 === 'OK tools off', a2)
    const a3 = await ask('thinking+tools')
    check('F', `板子拒旧语法 +tools`, a3.startsWith('ERR'), a3)
    await ask('off')
    sp.close(() => {})
  }
}

console.log(`\n========== 结果 ==========`)
console.log(`  通过 ${pass}   失败 ${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
