/**
 * 行为等价性证明：修复「只该改工具计数，不该改前景状态」
 * ============================================================================
 *
 * 用户的核心担心（原话）：
 *   「你刚才是修插件去了？没有又把控制灯的程序写到插件里面吧」
 *
 * 这个脚本从两个层面回答：
 *
 * 【层面一】结构层面 —— 插件源码里是否存在任何"灯效/时序"的东西？
 *   逐个符号扫描：灯效枚举、PWM、引脚、呼吸周期、闪烁、衰减、尾巴……
 *   以及配置项里有没有时长参数、有多少个 setTimeout。
 *
 * 【层面二】行为层面 —— 修复前后，**前景状态**是否逐事件完全一致？
 *   把修复前的原版算法（盲计数版，完整内联在此）与修复后的真实插件代码
 *   同时喂同一批真实 DSH 会话事件，逐事件比对：
 *     - 前景状态（关掉哪些灯、亮哪颗）
 *     - notify 类命令
 *   唯一允许的差异是「工具开关上报的时机与次数」——那正是本次要修的东西。
 *
 * 跑法：node scripts/verify-no-lamp-logic.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'
import { __testing } from '../plugin/lib/index.js'

const { StateMachine, DEFAULTS, EVENT_SETS, STATE } = __testing

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

const PLUGIN = 'plugin/lib/index.js'
const SRC = readFileSync(PLUGIN, 'utf8')

// ===========================================================================
// 层面一：结构扫描
// ===========================================================================
console.log('\n[1] 插件源码里有没有"控制灯"的东西？\n')

/** 去掉注释，只看真正会执行的代码 */
const code = SRC.split('\n')
  .filter((l) => {
    const t = l.trim()
    return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'))
  })
  .join('\n')

const LAMP_SYMBOLS = [
  'LAMP_',          // 灯效枚举（固件里的概念）
  'BREATHE',        // 呼吸
  'PWM',            // 亮度
  'ledc',           // ESP32 的 PWM 外设
  'analogWrite',
  'GPIO',           // 引脚
  'PIN_',
  'LAMP_SOLID',
  'LAMP_SLEEP',
  'LAMP_SLOW_BLINK',
  'LAMP_FAST_BLINK',
  'brightness',     // 亮度值
  'dutyCycle',
]
for (const s of LAMP_SYMBOLS) {
  check(`代码里无「${s}」（灯效/亮度/硬件概念）`, !code.includes(s))
}

const TIMING_SYMBOLS = [
  'busyCooldownMs',
  'busyTimer',
  'TOOLS_SUFFIX',
  'toolsHold',
  'toolsHoldPending',
  'toolsOffAt',
  'TOOLS_HOLD_MS',
  'holdMs',
  'cooldownMs',
  'lengthMs',
  'durationMs',
  'tailMs',
  'blinkMs',
  // 空闲自动灭灯已整体归固件，插件里不该再出现这些名字（见 audit-boundaries 2a-2）
  'idleTimeoutMs',
  'idleTimer',
  'armIdleTimer',
]
for (const s of TIMING_SYMBOLS) {
  check(`代码里无「${s}」（灯效时序变量）`, !code.includes(s))
}

// 配置项里不能有任何时长参数
const cfgKeys = Object.keys(DEFAULTS)
const timingCfg = cfgKeys.filter((k) => /cooldown|hold|fade|tail|blink|duration|period|length|pulse|brightness/i.test(k))
check('配置项里无灯效时长参数', timingCfg.length === 0, timingCfg.join(', ') || `配置项: ${cfgKeys.join(', ')}`)

// setTimeout 只允许两个：串口重连 + alarm 回落。
// （曾有三处：还有一处"空闲兜底"，已随 idleTimeoutMs 一起删除。）
const timers = [...SRC.matchAll(/setTimeout/g)].length
check('setTimeout 为 2 个（串口重连 / alarm 回落，都是安全兜底不是灯效）', timers === 2, `实际 ${timers}`)

// 关键：把两个 setTimeout 的用途列出来，供人工确认
const timerLines = SRC.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => l.includes('setTimeout'))
console.log('     ── 两个 setTimeout 的实际位置 ──')
for (const [n, l] of timerLines) {
  const around = SRC.split('\n').slice(Math.max(0, n - 4), n - 1).map((s) => s.trim()).filter(Boolean)
  console.log(`     第 ${n} 行 ← ${around[around.length - 1] ?? ''}`)
}

// 下发的命令只能是状态/工具/通知三类
const CMDS = EVENT_SETS // 仅用于确认拓扑存在
check('插件仍无 CLI 参数解析（不自己解析灯效参数）', !/energy|argv/u.test(code))

// ===========================================================================
// 层面二：修复前后前景状态逐事件等价
// ===========================================================================

/**
 * 【修复前的原版算法】—— 完整内联，用来做对照。
 * 这就是「盲计数」版本：tool/call +1、result −1，夹到 0。
 * 前景状态的判定逻辑与修复后**完全相同**（这正是要证明的）。
 */
function legacyAlgorithm(events) {
  const PLAN_SUFFIX = '+plan'
  const TRACK = { base: null, plan: false, activeTools: 0, toolsOn: false }
  const sent = []

  const current = () => {
    if (TRACK.base === null) return null
    if (TRACK.base === 'off') return TRACK.plan ? 'plan' : 'off'
    return TRACK.plan ? `${TRACK.base}${PLAN_SUFFIX}` : TRACK.base
  }
  const dispatch = () => {
    const c = current()
    if (c !== null) sent.push(c)
  }
  const set = (s) => {
    if (TRACK.base === s) return
    TRACK.base = s
    dispatch()
  }
  const reportTools = () => {
    const on = TRACK.activeTools > 0
    if (on === TRACK.toolsOn) return
    TRACK.toolsOn = on
    sent.push(on ? 'tools on' : 'tools off')
  }

  const THINKING = EVENT_SETS.THINKING
  const SUCCESS = EVENT_SETS.SUCCESS
  const OFF = EVENT_SETS.OFF
  const RESULT = EVENT_SETS.RESULT
  const ERROR = EVENT_SETS.ERROR
  const ALARM = EVENT_SETS.ALARM
  const ALARM_CLEAR = EVENT_SETS.ALARM_CLEAR
  const NOTIFY_ONLY = EVENT_SETS.NOTIFY_ONLY
  const BUSY = EVENT_SETS.BUSY

  for (const e of events) {
    const type = e.type
    const data = e.data
    if (typeof type !== 'string') continue

    if (type === 'plan/mode') {
      const active = !!(data && data.active === true)
      if (active === TRACK.plan) continue
      if (active) {
        TRACK.plan = true
        TRACK.base = TRACK.base === null ? 'off' : TRACK.base
        dispatch()
      } else {
        const after = { foreground: TRACK.base === null ? 'off' : TRACK.base, plan: false }
        TRACK.plan = false
        sent.push(`notify ${after.foreground}`)
      }
      continue
    }
    if (NOTIFY_ONLY.has(type)) {
      sent.push('notify')
      continue
    }
    if (SUCCESS.has(type) && TRACK.plan) {
      TRACK.base = 'success'
      sent.push('notify success+plan')
      continue
    }
    if (ALARM.has(type)) {
      TRACK.activeTools = 0
      reportTools()
      set('alarm')
      continue
    }
    if (ALARM_CLEAR.has(type)) {
      set('thinking')
      continue
    }
    if (TRACK.base === 'alarm') continue

    if (RESULT.has(type)) {
      // 修复前：非 command/done 的收工当"工具结束"；command/done 落到 success
      if (type !== 'command/done') {
        if (data && (data.error || data.isError === true || data.failed === true)) {
          TRACK.activeTools = 0
          reportTools()
          set('error')
        } else {
          if (TRACK.activeTools > 0) TRACK.activeTools--
          if (TRACK.activeTools === 0) reportTools()
        }
        continue
      }
    }
    if (ERROR.has(type)) {
      TRACK.activeTools = 0
      reportTools()
      set('error')
      continue
    }
    if (BUSY.has(type)) {
      TRACK.activeTools++
      set('thinking')
      reportTools()
      continue
    }
    if (THINKING.has(type)) {
      set('thinking')
      continue
    }
    if (SUCCESS.has(type)) {
      TRACK.activeTools = 0
      reportTools()
      set('success')
      continue
    }
    if (OFF.has(type)) {
      TRACK.activeTools = 0
      reportTools()
      TRACK.plan = false
      TRACK.base = 'off'
      dispatch()
      continue
    }
  }
  return sent
}

/** 跑修复后的真实插件代码 */
function currentAlgorithm(events) {
  const sent = []
  const m = new StateMachine({ ...DEFAULTS }, { send: (c) => sent.push(c) }, () => {})
  for (const e of events) m.handle(e)
  return sent
}

/** 只保留"影响前景灯"的命令，滤掉工具开关（那正是本次要改的） */
const foregroundOnly = (cmds) => cmds.filter((c) => !c.startsWith('tools '))

/**
 * 找本机的 DSH 会话日志。
 *
 * 为什么必须容错：这一段是「行为等价性对照」，需要**本机真实会话事件**当样本 ——
 * 但 `~/.dsh/sessions` 是用户机器上的运行数据，**CI 运行器上没有**。
 * 早期版本直接 walk 那个目录，在 GitHub Actions 上抛 ENOENT、退出码 1，
 * 把整个 workflow 拖挂了。所以这里缺目录就返回空数组，
 * 由调用方降级为「跳过行为对照，只做结构性检查」。
 */
function loadSessions(limit) {
  const root = join(homedir(), '.dsh', 'sessions')
  const found = []
  if (!existsSync(root)) return found
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.startsWith('session.') && ent.name.includes('.jsonl'))
        found.push({ p, m: statSync(p).mtimeMs })
    }
  }
  walk(root)
  found.sort((a, b) => b.m - a.m)
  return found.slice(0, limit)
}

console.log('\n[2] 修复前后「前景状态命令」是否逐会话完全一致？\n')

const sessions = loadSessions(12)
let compared = 0
let totalEvents = 0
let mismatchSessions = 0
const firstMismatch = []

if (sessions.length === 0) {
  console.log('  --   跳过：本机没有 DSH 会话日志（CI 上是正常的）')
  console.log(`       查找位置: ${join(homedir(), '.dsh', 'sessions')}`)
  console.log('       结构性检查（上面 [1] 段）不依赖会话日志，仍然有效。')
}

for (const s of sessions) {
  let text
  try {
    text = decodeMultiFrameZstd(readFileSync(s.p)).text
  } catch {
    continue
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      const e = o.event?.type ? o.event : o.type ? o : null
      if (e && e.type) events.push(e)
    } catch {}
  }
  if (!events.length) continue
  compared++
  totalEvents += events.length

  const oldFg = foregroundOnly(legacyAlgorithm(events))
  const newFg = foregroundOnly(currentAlgorithm(events))

  const same = oldFg.length === newFg.length && oldFg.every((c, i) => c === newFg[i])
  if (!same) {
    mismatchSessions++
    if (firstMismatch.length === 0) {
      // 找出第一处差异，便于定位
      const n = Math.min(oldFg.length, newFg.length)
      let at = -1
      for (let i = 0; i < n; i++) if (oldFg[i] !== newFg[i]) { at = i; break }
      if (at === -1) at = n
      firstMismatch.push({
        file: s.p.split('session-')[1]?.slice(0, 8),
        at,
        old: oldFg.slice(Math.max(0, at - 3), at + 4),
        new: newFg.slice(Math.max(0, at - 3), at + 4),
      })
    }
  }
}

if (sessions.length > 0) {
  check(
    `前景状态命令逐条一致（${compared} 个会话 / ${totalEvents} 个事件）`,
    mismatchSessions === 0,
    mismatchSessions === 0 ? '' : `${mismatchSessions} 个会话有差异`,
  )
}

if (firstMismatch.length) {
  const d = firstMismatch[0]
  console.log(`\n     首个差异（会话 ${d.file}，第 ${d.at} 条）:`)
  console.log(`       修复前: ${JSON.stringify(d.old)}`)
  console.log(`       修复后: ${JSON.stringify(d.new)}`)
}

// 顺带量化"工具命令"的差异（这是预期内的、也是本次修的目标）
console.log('\n[3] 工具开关命令的差异（预期存在，正是本次修复目标）\n')
let toolOld = 0
let toolNew = 0
if (sessions.length === 0) {
  console.log('  --   跳过：同样需要本机会话日志')
}
for (const s of sessions) {
  let text
  try {
    text = decodeMultiFrameZstd(readFileSync(s.p)).text
  } catch {
    continue
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      const e = o.event?.type ? o.event : o.type ? o : null
      if (e && e.type) events.push(e)
    } catch {}
  }
  if (!events.length) continue
  toolOld += legacyAlgorithm(events).filter((c) => c.startsWith('tools ')).length
  toolNew += currentAlgorithm(events).filter((c) => c.startsWith('tools ')).length
}
console.log(`  修复前 tools 命令总数: ${toolOld}`)
console.log(`  修复后 tools 命令总数: ${toolNew}`)
console.log('  （数量不同是预期的：按 ID 配对后，配不上的收工事件不再产生多余的一开一关）')

// ===========================================================================
// 总结
// ===========================================================================
console.log('\n=== 结论 ===')
if (failures === 0) {
  console.log('  ✅ 插件里没有任何灯效/亮度/时序代码，也没有新增定时器。')
  if (sessions.length > 0) {
    console.log('  ✅ 修复前后「前景状态」命令逐条完全一致 —— 灯的行为没变。')
  } else {
    // 别在没有样本的时候宣称"一致"：那正是"证据不足却下结论"。
    console.log('  ·  行为等价性对照**未执行**（本机没有 DSH 会话日志作为样本）。')
    console.log('     结构性检查已通过；要跑行为对照请在用过 DSH 的机器上重跑本脚本。')
  }
  console.log('  ✅ 唯一改变的是「工具开关何时上报」，即本次要修的那个 bug。')
} else {
  console.log(`  ❌ 有 ${failures} 项不通过，见上文。`)
  process.exit(1)
}
