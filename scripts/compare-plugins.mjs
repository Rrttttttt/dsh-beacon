/**
 * 对照实验：dsh-beacon 与 dsh-led-bridge 对同一串事件的下发命令是否一致
 * ============================================================================
 *
 * 做法：给两个插件喂完全相同的事件序列，记录每一步真正会写到串口上的命令行，
 *       逐条比对。不读注释、不看文档 —— 只看两个实现的实际行为。
 *
 * 为什么用假传输层：dsh-beacon 的 node_modules 还没装，而它的 SerialSink
 * 只要求 transport 实现 send(command)，所以塞一个记录器即可跑通真实链路
 * （StateMachine → SerialSink → 记录器），不需要真串口。
 *
 * 跑法：node scripts/compare-plugins.mjs
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const BEACON = pathToFileURL('D:/Agent Workstation/dsh状态广播插件/plugin/lib/index.js').href
const BRIDGE = pathToFileURL(
  'D:/Agent Workstation/ESP32实现Claude状态灯/基于ESP32-C3的deepseek harness状态显示器/plugin/lib/index.js',
).href

const beacon = await import(BEACON)
const bridge = await import(BRIDGE)

const B = beacon.__testing
const L = bridge.__testing

// ---------------------------------------------------------------------------
// 事件场景：两份实现都跑这些
// ---------------------------------------------------------------------------

const SCENARIOS = [
  {
    name: '普通一轮：开始 → 思考 → 工具 → 工具成功 → 答完',
    events: [
      ['turn/start'],
      ['assistant/attempt'],
      ['tool/call'],
      ['tool/result', { message: {} }],
      ['turn/end'],
    ],
  },
  {
    name: '工具失败 → 应判 error',
    events: [
      ['tool/call'],
      ['tool/result', { error: { name: 'E', code: 'X' } }],
    ],
  },
  {
    name: '等你批准 → alarm，处理后回 thinking',
    events: [
      ['tool/call'],
      ['approval/asked', { id: 'a1', toolName: 'pwsh' }],
      ['tool/call'],
      ['approval/decided', { id: 'a1', outcome: 'allow' }],
    ],
  },
  {
    name: '模型重试 → error',
    events: [['llm/retry'], ['llm/retry-started']],
  },
  {
    name: '计划模式：进入 → 思考 → 工具 → 答完 → 退出',
    events: [
      ['plan/mode', { active: true }],
      ['assistant/attempt'],
      ['tool/call'],
      ['turn/end'],
      ['plan/mode', { active: false }],
    ],
  },
  {
    name: '计划模式下收到 goal/change 与 sandbox/mode',
    events: [
      ['plan/mode', { active: true }],
      ['tool/call'],
      ['goal/change'],
      ['sandbox/mode', { mode: 'danger-full-access' }],
    ],
  },
  {
    name: '重复 plan/mode active:true → 不应重复下发',
    events: [
      ['plan/mode', { active: true }],
      ['plan/mode', { active: true }],
      ['assistant/attempt'],
    ],
  },
  {
    name: '会话收尾 → off（且清掉计划模式）',
    events: [
      ['plan/mode', { active: true }],
      ['session/end-seed'],
    ],
  },
  {
    name: '计划模式下出错 → error+plan',
    events: [
      ['plan/mode', { active: true }],
      ['llm/retry'],
    ],
  },
  {
    name: '计划模式下等批准 → alarm+plan',
    events: [
      ['plan/mode', { active: true }],
      ['approval/asked', { id: 'a2', toolName: 'fs' }],
    ],
  },
  {
    name: '未认识的事件 → 不该下发',
    events: [
      ['user/message'],
      ['system/message'],
      ['todo/write', { todos: [] }],
      ['model/selection'],
    ],
  },
]

// ---------------------------------------------------------------------------
// 两个 runner：各自走真实链路，记录命令行
// ---------------------------------------------------------------------------

/** dsh-beacon：StateMachine → SerialSink → 记录器 */
function runBeacon(events) {
  const cmds = []
  const transport = { send: (cmd) => cmds.push(cmd) }
  const sink = new B.SerialSink(transport)
  const machine = new B.StateMachine({ alarmTimeoutMs: 0, idleTimeoutMs: 0 }, sink, () => {})
  const steps = []
  for (const [type, data] of events) {
    const before = cmds.length
    machine.handle({ type, data })
    steps.push(cmds.slice(before))
  }
  machine.dispose()
  return steps
}

/** dsh-led-bridge：StateMachine → 传输层 → 记录器 */
function runBridge(events) {
  const cmds = []
  const transport = { send: (cmd) => cmds.push(cmd) }
  const machine = new L.StateMachine({ alarmTimeoutMs: 0, idleTimeoutMs: 0 }, transport, () => {})
  const steps = []
  for (const [type, data] of events) {
    const before = cmds.length
    machine.handle({ type, data })
    steps.push(cmds.slice(before))
  }
  machine.dispose()
  return steps
}

// ---------------------------------------------------------------------------
// 比对
// ---------------------------------------------------------------------------

let same = 0
let diff = 0

console.log('对照实验：同一事件序列，两个插件下发的命令\n')

for (const sc of SCENARIOS) {
  const a = runBeacon(sc.events)
  const b = runBridge(sc.events)
  const aFlat = a.map((x) => x.join(',') || '—')
  const bFlat = b.map((x) => x.join(',') || '—')
  const equal = JSON.stringify(aFlat) === JSON.stringify(bFlat)

  console.log(`--- ${sc.name}`)
  console.log(`    beacon : ${aFlat.join(' | ')}`)
  console.log(`    bridge : ${bFlat.join(' | ')}`)
  console.log(`    ${equal ? '✅ 完全一致' : '❌ 不一致'}`)
  console.log('')

  if (equal) {
    same++
  } else {
    diff++
    for (let i = 0; i < Math.max(aFlat.length, bFlat.length); i++) {
      if (aFlat[i] !== bFlat[i]) {
        console.log(`    第一个差异在步骤 ${i} (${sc.events[i] ? sc.events[i][0] : '?'}):`)
        console.log(`      beacon 发: ${aFlat[i]}`)
        console.log(`      bridge 发: ${bFlat[i]}`)
        break
      }
    }
    console.log('')
  }
}

// ---------------------------------------------------------------------------
// 事件表逐条比对（集合层面）
// ---------------------------------------------------------------------------

console.log('事件映射表逐条比对')
const SET_NAMES = Object.keys(B.EVENT_SETS)
for (const name of SET_NAMES) {
  const bs = B.EVENT_SETS[name]
  const ls = L.EVENT_SETS[name]
  if (!ls) {
    console.log(`  ❌ bridge 缺少 ${name}`)
    diff++
    continue
  }
  const onlyB = [...bs].filter((e) => !ls.has(e))
  const onlyL = [...ls].filter((e) => !bs.has(e))
  if (onlyB.length === 0 && onlyL.length === 0) {
    console.log(`  ✅ ${name}: ${bs.size} 项完全一致`)
    same++
  } else {
    console.log(`  ❌ ${name}: 仅 beacon 有 [${onlyB}] / 仅 bridge 有 [${onlyL}]`)
    diff++
  }
}

// 看两个 EVENT_SETS 是否同一组键
const bk = Object.keys(B.EVENT_SETS).sort().join(',')
const lk = Object.keys(L.EVENT_SETS).sort().join(',')
console.log(`  表名集合一致: ${bk === lk ? '✅' : '❌'}`)
if (bk !== lk) diff++

// STATE 常量
const bState = JSON.stringify(B.STATE)
const lState = JSON.stringify(L.STATE)
console.log(`  STATE 常量一致: ${bState === lState ? '✅ ' + bState : '❌'}`)
bState === lState ? same++ : diff++

// 线协议编码
console.log('\n线协议编码比对')
for (const [fg, plan] of [
  ['off', false], ['off', true],
  ['thinking', false], ['thinking', true],
  ['busy', true], ['error', true], ['alarm', true], ['success', true],
]) {
  const b = B.encodeState(fg, plan)
  // bridge 没有把 encodeState 单独导出（它只在传输层内部用），
  // 所以这里只打印 beacon 的编码；bridge 的等价行为已由上面的场景逐条验证。
  console.log(`  beacon encodeState('${fg}', ${plan}) = '${b}'`)
}
const bBlink = B.encodeBlink({ foreground: 'success', plan: true })
const bBlinkNull = B.encodeBlink(null)
console.log(`  beacon encodeBlink({success,plan:true}) = '${bBlink}'`)
console.log(`  beacon encodeBlink(null)               = '${bBlinkNull}'`)

// ---------------------------------------------------------------------------
// 已知差异（不是不一致，是能力差异）
// ---------------------------------------------------------------------------

console.log('\n=== 汇总 ===')
console.log(`  一致项: ${same}`)
console.log(`  差异项: ${diff}`)
console.log('')
console.log('导出面比对（能力差异，不是行为差异）:')
console.log('  注意: B 与 L 都是各自模块的 __testing 对象本身，不是模块命名空间。')
const bKeys = Object.keys(B).sort()
const lKeys = Object.keys(L).sort()
console.log(`  beacon __testing 导出 ${bKeys.length} 项`)
console.log(`  bridge __testing 导出 ${lKeys.length} 项`)
const onlyBeacon = bKeys.filter((k) => !lKeys.includes(k))
const onlyBridge = lKeys.filter((k) => !bKeys.includes(k))
console.log(`  仅 beacon 有 (${onlyBeacon.length}): ${onlyBeacon.join(', ')}`)
console.log(`  仅 bridge 有 (${onlyBridge.length}): ${onlyBridge.join(', ')}`)
console.log(`  两者都导出 StateMachine / EVENT_SETS / looksLikeFailure / pickPortPath: ` +
  `${['StateMachine', 'EVENT_SETS', 'looksLikeFailure', 'pickPortPath'].every((k) => bKeys.includes(k) && lKeys.includes(k))}`)

process.exit(diff === 0 ? 0 : 1)
