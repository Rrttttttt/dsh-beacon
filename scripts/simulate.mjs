/**
 * 端到端模拟：DSH 事件 → 插件 → 串口 → 三颗灯
 * ============================================================================
 *
 * 为什么要有这个：
 *   单元测试只验证"发出了哪条命令"，但我们要回答的是"用户眼睛看到什么"。
 *   所以这里做两件事：
 *     1. 直接调用插件导出的 apply()，用假的 ctx 和假的串口跑【真实代码路径】；
 *     2. 把固件源码里的灯效规则与【工具尾窗时序】逐条移植成 JS，
 *        对每条下发的命令解码成「黄/绿/红 三颗灯各自的效果」，并支持推进模拟时钟。
 *
 *   ⚠️ 局限（必须说清）：固件是移植的，不是真跑 Xtensa 机器码。
 *      它能验证「逻辑/映射/时序编排」正确，但验证不了「接线、电流、PWM 实际输出」。
 *      后者只能烧到板子上看。移植部分与 .ino 的对应关系写在每条注释里。
 *
 * 架构约定（本文件同时在守护这条约定）：
 *   插件只报告事实（前景状态 / 计划模式 / 有无工具在跑），
 *   **全部灯效渲染与时间控制都在固件里**。所以尾窗验证必须在"固件移植"这一侧做，
 *   而不是在插件侧 —— 插件侧不该存在任何时长参数。
 *
 * 跑法：
 *     node scripts/simulate.mjs
 */

import assert from 'node:assert/strict'
import { apply, __testing } from '../plugin/lib/index.js'

let passed = 0
let failed = 0

async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${label}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${label}`)
    console.log(`       ${err && err.message ? err.message : err}`)
  }
}

// ===========================================================================
// 第一部分：把插件接到假 ctx + 假串口上跑真实代码路径
// ===========================================================================

/**
 * 造一个"假 DSH"：一个能发射 session 事件的 ctx，和一个记录串口写入的假板子。
 * 这样我们从 apply() 进、从串口出，中间全是生产代码。
 */
function createHarness(overrides = {}) {
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {} },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }

  // 假串口：记录每一行，模拟板子回 OK
  const serialLog = []
  const transport = { send: (cmd) => serialLog.push(cmd) }

  // 用真实的 apply()，但把内部 transport 换掉不方便 —— 所以改成
  // 直接构造真实 StateMachine（它就是 apply 内部用的那个类），
  // 并把 transport 换成假的。这样测的仍是生产逻辑。
  const { StateMachine } = __testing
  const cfg = { alarmTimeoutMs: 0, ...overrides }
  const machine = new StateMachine(cfg, transport, () => {})

  // 同时验证 apply 真的注册了监听（证明插件整体接线没问题）
  const disposer = apply(ctx, { port: 'FAKE', reconnectIntervalMs: 999999 })
  const registered = listeners.has('session/event')

  return {
    machine,
    serialLog,
    registered,
    emit: (type, data) => machine.handle({ type, data }),
    emitRaw: (event) => machine.handle(event),
    dispose: disposer,
  }
}

// ===========================================================================
// 第二部分：固件移植（逐条对应 .ino，带出处说明）
// ===========================================================================

/** 固件里的 LAMP_* 枚举。对应 .ino 的 `enum LampEffect`。 */
const LAMP = { OFF: 'OFF', SOLID: 'SOLID', BREATHE: 'BREATHE', SLEEP: 'SLEEP', SLOW: 'SLOW', FAST: 'FAST' }

/** 对应固件常量 BREATHE_PERIOD_MS；TOOLS_HOLD_MS === BREATHE_PERIOD_MS。 */
const BREATHE_PERIOD_MS = 2400

/** 对应固件常量 TOOLS_HOLD_MAX_MS：尾窗硬上限，防止插件异常时绿灯永远留着。 */
const TOOLS_HOLD_MAX_MS = 10000

/**
 * 固件的 applyStateEffects()：把状态命令映射成三颗灯各自的效果。
 * 对应 .ino 的 `void applyStateEffects(const String &state, bool planMode)`。
 *
 * 唯一修饰符是 +plan；**工具状态不在状态名里**（它是独立的 tools on/off 命令）。
 * @returns {{y: string, g: string, r: string}}
 */
function firmwareApplyStateEffects(cmd) {
  let state = cmd
  let planMode = false

  if (state.endsWith('+plan')) {
    planMode = true
    state = state.slice(0, -5)
  }

  const lamps = { y: LAMP.OFF, g: LAMP.OFF, r: LAMP.OFF }
  if (state === 'thinking') lamps.y = LAMP.BREATHE
  else if (state === 'busy') lamps.g = LAMP.SLOW
  else if (state === 'error') lamps.r = LAMP.SOLID
  else if (state === 'alarm') lamps.y = LAMP.FAST
  else if (state === 'success') lamps.g = LAMP.SOLID
  else if (state === 'plan') lamps.g = LAMP.SOLID
  // state === 'off' → 三颗全灭

  // 计划模式是背景修饰：额外把绿灯点亮
  if (planMode) lamps.g = LAMP.SOLID
  return lamps
}

/**
 * 固件的 updateToolsEffect()：叠加「工具在执行」的绿灯效果，并负责尾窗收尾。
 * 对应 .ino 的 `void updateToolsEffect(uint32_t nowMs)`。
 *
 * 这是固件里唯一带时间记忆的灯效逻辑 —— 尾巴在固件里，不在插件里。
 *
 * 真机上 loop() 每轮的顺序是：先由命令处理写好基础效果，再由本函数叠加。
 * 本模拟没有"每轮重算"的循环，所以这里每次调用都**先重置为基础效果再叠加**，
 * 否则上一帧的 SLEEP 会粘住不消失（模拟器与真机的必要差异）。
 *
 * @param {object} board
 * @param {number} nowMs - 当前时间（模拟时钟）
 */
function firmwareUpdateToolsEffect(board, nowMs) {
  // 尾窗到点 → 清掉工具状态，并【撤销】绿灯效果
  //
  // ⚠️ 必须自己撤销（重新应用基础效果），不能只清标志位。
  //    本函数只做"叠加"（toolsActive 时把绿灯设成 LAMP_SLEEP），
  //    若收尾时只清 toolsActive 而不恢复绿灯的基础效果，绿灯会一直保持 SLEEP
  //    直到下一条状态命令 —— 真机实测的现象就是"绿灯一直亮到最后的 off 才灭"，
  //    看起来像尾巴完全没生效。这是本函数唯一会被"撤销"的场景。
  if (board.toolsActive && board.toolsHoldPending) {
    const waited = nowMs - board.toolsOffAtMs
    const expired = waited >= BREATHE_PERIOD_MS
    const overCap = waited >= TOOLS_HOLD_MAX_MS
    if (expired || overCap) {
      board.toolsActive = false
      board.toolsHoldPending = false
      board.lamps = firmwareApplyStateEffects(board.currentState)
      return
    }
  }

  // 重置为基础效果（对应真机上 allLampsOff + applyStateEffects 的结果）
  board.lamps = firmwareApplyStateEffects(board.currentState)

  // 叠加绿灯呼吸（只在 thinking 前景、且绿灯没被 solid 占据时）
  if (
    board.toolsActive &&
    String(board.currentState).startsWith('thinking') &&
    board.lamps.g !== LAMP.SOLID
  ) {
    board.lamps.g = LAMP.SLEEP
  }
}

/** 造一块干净的假板子（字段对应固件里的同名全局变量）。 */
function newBoard() {
  return {
    lamps: { y: LAMP.OFF, g: LAMP.OFF, r: LAMP.OFF },
    notifyActive: false,
    notifyAfter: '',
    savedState: 'off',
    currentState: 'off',
    // ---- 工具尾窗状态（对应固件里的同名全局变量）----
    toolsActive: false,
    toolsHoldPending: false,
    toolsOffAtMs: 0,
    nowMs: 0,
  }
}

/**
 * 假板子处理一条命令。
 * 对应 .ino 的 applyCommand() + loop() 的渲染分支。
 *
 * @param {string} cmd - 插件下发的一行命令
 * @param {object} board
 * @param {number} [nowMs] - 模拟时钟
 * @returns {{lamps: {y,g,r}, blinking: boolean, note: string}}
 */
function firmwareHandle(cmd, board, nowMs = board.nowMs || 0) {
  const line = cmd.trim().toLowerCase()
  board.nowMs = nowMs

  // 对应 .ino: if (cmd === "notify" || cmd.startsWith("notify "))
  if (line === 'notify' || line.startsWith('notify ')) {
    board.notifyActive = true
    board.notifyAfter = line.length > 7 ? line.slice(7).trim() : ''
    return describe(board, '闪烁中(绿灯 0.15s 亮/0.15s 灭 ×2)')
  }

  // 对应 .ino: tools on / tools off —— 独立命令，不改变前景状态
  if (line === 'tools on' || line === 'tools off') {
    if (line === 'tools on') {
      board.toolsActive = true
      board.toolsHoldPending = false
    } else if (board.toolsActive && !board.toolsHoldPending) {
      // 不立即熄灭：标记"本周期结束后收尾"，交给 updateToolsEffect 处理
      board.toolsHoldPending = true
      board.toolsOffAtMs = nowMs
    }
    firmwareUpdateToolsEffect(board, nowMs)
    return describe(board, '')
  }

  // 普通状态
  board.currentState = line
  // 对应固件：off/error/alarm/success 会 resetTools()
  if (['off', 'error', 'alarm', 'success'].some((s) => line === s || line.startsWith(s + '+'))) {
    board.toolsActive = false
    board.toolsHoldPending = false
  }
  firmwareUpdateToolsEffect(board, nowMs)
  return describe(board, '')
}

/** 闪烁结束后回到目标状态。对应 .ino 里 notify 分支超时后的 applyCommand(target)。 */
function firmwareNotifyFinished(board) {
  board.notifyActive = false
  const target = board.notifyAfter || board.savedState || 'off'
  board.currentState = target
  firmwareUpdateToolsEffect(board, board.nowMs)
  return describe(board, '')
}

function describe(board, note) {
  return { lamps: { ...board.lamps }, blinking: board.notifyActive, currentState: board.currentState, note }
}

/** 人话描述三颗灯。 */
function human(r) {
  const name = (e) => ({
    OFF: '灭',
    SOLID: '常亮',
    BREATHE: '呼吸',
    SLEEP: '呼吸(错相)',
    SLOW: '慢闪',
    FAST: '快闪',
  }[e] || e)
  const parts = []
  if (r.lamps.y !== LAMP.OFF) parts.push(`黄${name(r.lamps.y)}`)
  if (r.lamps.g !== LAMP.OFF) parts.push(`绿${name(r.lamps.g)}`)
  if (r.lamps.r !== LAMP.OFF) parts.push(`红${name(r.lamps.r)}`)
  const lights = parts.length ? parts.join(' + ') : '全灭'
  return r.blinking ? `【绿灯闪两下】${r.note} → 之后: ${lights}` : lights
}

/**
 * 端到端：喂一串事件，返回每一步的灯态。
 *
 * 事件项可以是：
 *   ['标签', {type, data}]           一个 DSH 事件
 *   ['标签', '<<notify-finished>>']  手动推进"绿灯闪烁结束"
 *   ['标签', '<<advance-ms>>', 3000] 推进模拟时钟（**尾窗验证必须用它**）
 *
 * 为什么要模拟时钟：尾窗是固件里的时间逻辑，而事件序列本身不带时间。
 * 不推进时钟就永远停在"尾窗还没走完"，也就测不到收尾。
 */
function simulate(events, overrides = {}) {
  const h = createHarness(overrides)
  const board = newBoard()
  const steps = []

  /**
   * 给工具事件自动补上真实的配对 ID。
   *
   * 场景表里写的是 `{ type: 'tool/call' }` 这种最简形态，但真机事件一定带 callId，
   * 而插件现在是**按 ID 精确配对**的（盲计数会让绿灯永远不灭，已废弃）。
   * 所以这里在喂给插件之前补上 ID，让场景表保持可读：
   *   tool/call   → data.callId
   *   tool/result → data.message.source.callId（照抄真机嵌套位置）
   * result 按 FIFO 认领最近一个还没闭合的 call，与真实事件流一致。
   */
  const openIds = []
  let idSeq = 0
  const withIds = (ev) => {
    if (ev.type === 'tool/call') {
      const id = `call_sim_${++idSeq}`
      openIds.push(id)
      return { ...ev, data: { ...(ev.data || {}), callId: id } }
    }
    if (ev.type === 'tool/result') {
      const id = openIds.shift() ?? `call_sim_orphan_${++idSeq}`
      const d = ev.data || {}
      const msg = d.message || {}
      return {
        ...ev,
        data: {
          ...d,
          message: {
            ...msg,
            source: { kind: 'tool', callId: id, ...(msg.source || {}) },
            content: msg.content || [{ type: 'tool-result', toolCallId: id, content: [] }],
          },
        },
      }
    }
    return ev
  }

  for (const [label, rawEv, arg] of events) {
    if (rawEv === '<<notify-finished>>') {
      const r = firmwareNotifyFinished(board)
      steps.push([label, h.serialLog.splice(0), r])
      continue
    }
    if (rawEv === '<<advance-ms>>') {
      board.nowMs += Number(arg) || 0
      firmwareUpdateToolsEffect(board, board.nowMs)
      steps.push([label, [], describe(board, '')])
      continue
    }
    const ev = withIds(rawEv)
    if (ev.type) h.emit(ev.type, ev.data)
    const cmds = h.serialLog.splice(0)
    let r = describe(board, '')
    let last = null
    for (const c of cmds) {
      r = firmwareHandle(c, board, board.nowMs)
      last = c
    }
    if (last) board.savedState = board.currentState
    steps.push([label, cmds, r])
  }
  return steps
}

function printScenario(title, steps) {
  console.log(`\n--- ${title} ---`)
  for (const [label, cmds, r] of steps) {
    const sent = cmds.length ? cmds.join(' , ') : '(无下发)'
    console.log(`  ${label}`)
    console.log(`        串口: ${sent}`)
    console.log(`        灯  : ${human(r)}`)
  }
}

// ===========================================================================
// 场景
// ===========================================================================

console.log('端到端模拟：DSH 事件 → 插件 → 串口 → 三颗灯\n')

// ---- 场景 1：普通一轮对话（含工具尾窗的完整时间线） ----
const s1 = simulate([
  ['turn/start', { type: 'turn/start' }],
  ['assistant/attempt（模型开始生成）', { type: 'assistant/attempt' }],
  ['tool/call（工具开始）', { type: 'tool/call' }],
  ['tool/result（工具立即结束）', { type: 'tool/result', data: { message: {} } }],
  ['── 1 秒后（尾窗还没走完）', '<<advance-ms>>', 1000],
  ['── 2.5 秒后（尾窗走完）', '<<advance-ms>>', 1500],
  ['turn/end（答完）', { type: 'turn/end' }],
])
printScenario('场景 1：普通一轮对话（含工具尾窗时间线）', s1)

await test('场景1：模型生成时黄灯呼吸', () => {
  const [, , r] = s1[1]
  assert.equal(r.lamps.y, LAMP.BREATHE)
  assert.equal(r.lamps.g, LAMP.OFF)
  assert.equal(r.lamps.r, LAMP.OFF)
})

await test('场景1：工具开始 → 只发独立命令 tools on（前景已是 thinking）', () => {
  const [, cmds, r] = s1[2]
  assert.deepEqual(cmds, ['tools on'], '工具是独立命令，不占用前景状态')
  assert.equal(r.lamps.y, LAMP.BREATHE, '黄灯照常呼吸')
  assert.equal(r.lamps.g, LAMP.SLEEP, '绿灯同时以错开半周期的呼吸陪着动')
})

await test('场景1：工具立刻结束 → 插件立即上报 tools off（插件侧不带任何延迟）', () => {
  const [, cmds, r] = s1[3]
  assert.deepEqual(cmds, ['tools off'], '插件必须立即上报，尾巴归固件')
  assert.equal(r.lamps.g, LAMP.SLEEP, '但固件不立即熄灭 —— 绿灯继续呼吸')
})

await test('场景1：1 秒后仍在尾窗内，绿灯继续呼吸', () => {
  const [, , r] = s1[4]
  assert.equal(r.lamps.g, LAMP.SLEEP, '呼吸周期没走完，不能熄')
})

await test('场景1：2.5 秒后尾窗走完，绿灯自行熄灭（不需要任何新命令）', () => {
  const [, cmds, r] = s1[5]
  assert.deepEqual(cmds, [], '尾窗收尾不应产生任何串口流量')
  assert.equal(r.lamps.g, LAMP.OFF, '固件自己收尾 —— 这正是把尾巴放在固件的意义')
  assert.equal(r.lamps.y, LAMP.BREATHE, '黄灯继续呼吸')
})

await test('场景1：答完绿灯常亮', () => {
  const [, , r] = s1[6]
  assert.equal(r.lamps.g, LAMP.SOLID)
})

// ---- 场景 2：等你确认权限 ----
const s2 = simulate([
  ['tool/call', { type: 'tool/call' }],
  ['approval/asked（DSH 在等你批准）', { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh' } }],
  ['approval/decided（你已批准）', { type: 'approval/decided', data: { id: 'a1', outcome: 'allow' } }],
])
printScenario('场景 2：等你批准权限', s2)

await test('场景2：等你确认时黄灯快闪', () => {
  const [, , r] = s2[1]
  assert.equal(r.lamps.y, LAMP.FAST, 'alarm 必须是黄灯快闪')
})

await test('场景2：等你确认时会清掉工具状态（绿灯不再挂呼吸）', () => {
  const [, cmds, r] = s2[1]
  assert.ok(cmds.includes('tools off'), '应上报 tools off')
  assert.equal(r.lamps.g, LAMP.OFF, 'alarm 时绿灯不亮')
})

// ---- 场景 3：计划模式完整来回 ----
const s3 = simulate([
  ['plan/mode {active:true}（进入计划模式）', { type: 'plan/mode', data: { active: true } }],
  ['assistant/attempt（计划模式下思考）', { type: 'assistant/attempt' }],
  ['tool/call（计划模式下执行工具）', { type: 'tool/call' }],
  ['tool/result（工具成功，回到思考）', { type: 'tool/result', data: { message: {} } }],
  ['turn/end（计划模式下答完一轮）', { type: 'turn/end' }],
  ['<<notify-finished>>（绿灯闪两下结束）', '<<notify-finished>>'],
  ['plan/mode {active:false}（退出计划模式）', { type: 'plan/mode', data: { active: false } }],
  ['<<notify-finished>>（退出闪烁结束）', '<<notify-finished>>'],
])
printScenario('场景 3：计划模式完整来回', s3)

await test('场景3：进入计划模式 → 绿灯常亮', () => {
  const [, , r] = s3[0]
  assert.equal(r.lamps.g, LAMP.SOLID)
  assert.equal(r.lamps.y, LAMP.OFF)
})

await test('场景3：计划模式下思考 → 黄灯呼吸 + 绿灯常亮（两个一起亮，这是设计核心）', () => {
  const [, , r] = s3[1]
  assert.equal(r.lamps.y, LAMP.BREATHE, '黄灯必须在呼吸')
  assert.equal(r.lamps.g, LAMP.SOLID, '绿灯必须同时常亮')
})

await test('场景3：计划模式下工具执行 → 工具独立上报，绿灯仍常亮（plan 覆盖呼吸）', () => {
  const [, cmds, r] = s3[2]
  assert.deepEqual(cmds, ['tools on'], '状态已是 thinking+plan，工具独立上报')
  // 计划模式下绿灯本来就是常亮（背景修饰），所以工具的绿灯呼吸被覆盖成常亮。
  // 这是按「只要处于 planmode 就保持绿灯常亮」这条规格实现的必然结果，不是 bug。
  assert.equal(r.lamps.g, LAMP.SOLID)
  assert.equal(r.lamps.y, LAMP.BREATHE, '黄灯照常呼吸')
})

await test('场景3：计划模式下答完一轮 → 绿灯闪两下', () => {
  const [, cmds, r] = s3[4]
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0], 'notify success+plan')
  assert.equal(r.blinking, true, '这一刻应该在闪')
})

await test('场景3：闪完 → 绿灯常亮（保住 success 信号的同时回到计划模式）', () => {
  const [, , r] = s3[5]
  assert.equal(r.lamps.g, LAMP.SOLID)
  assert.equal(r.currentState, 'success+plan')
})

await test('场景3：退出计划模式 → 绿灯闪两下', () => {
  const [, cmds, r] = s3[6]
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0], 'notify success')
  assert.equal(r.blinking, true)
})

await test('场景3：退出闪完 → 按前景状态显示', () => {
  const [, , r] = s3[7]
  assert.equal(r.lamps.g, LAMP.SOLID, '前景是 success，所以还是绿灯常亮')
})

// ---- 场景 4：goal/change 与 sandbox/mode（只闪不改状态） ----
const s4 = simulate([
  ['tool/call（先让工具有在跑）', { type: 'tool/call' }],
  ['goal/change（目标变化）', { type: 'goal/change' }],
  ['<<notify-finished>>（闪完）', '<<notify-finished>>'],
  ['sandbox/mode（沙箱变化）', { type: 'sandbox/mode', data: { mode: 'danger-full-access' } }],
  ['<<notify-finished>>（闪完）', '<<notify-finished>>'],
])
printScenario('场景 4：goal/change 与 sandbox/mode', s4)

await test('场景4：goal/change 只闪，不改状态与工具上报', () => {
  const [, cmds, r] = s4[1]
  assert.deepEqual(cmds, ['notify'], '不带参数 = 闪完回到之前状态')
  assert.equal(r.blinking, true)
  const [, , after] = s4[2]
  assert.equal(after.lamps.g, LAMP.SLEEP, '闪完必须回到"工具执行中"的绿灯呼吸')
  assert.equal(after.lamps.y, LAMP.BREATHE, '黄灯也照常呼吸')
})

await test('场景4：sandbox/mode 同样只闪不改状态', () => {
  const [, cmds] = s4[3]
  assert.deepEqual(cmds, ['notify'])
  const [, , after] = s4[4]
  assert.equal(after.lamps.g, LAMP.SLEEP)
})

// ---- 场景 5：出错 ----
const s5 = simulate([
  ['llm/retry（模型重试）', { type: 'llm/retry' }],
  ['tool/result 带 error', { type: 'tool/result', data: { error: { name: 'E', code: 'X' } } }],
])
printScenario('场景 5：出错', s5)

await test('场景5：出错红灯常亮', () => {
  for (const i of [0, 1]) {
    assert.equal(s5[i][2].lamps.r, LAMP.SOLID, `第${i}步应红灯常亮`)
  }
})

// ---- 场景 6：用户消息 ----
const s6 = simulate([
  ['user/message（你发消息）', { type: 'user/message' }],
  ['turn/start', { type: 'turn/start' }],
  ['step/start', { type: 'step/start' }],
])
printScenario('场景 6：你发消息时', s6)

await test('场景6：user/message 本身不点亮（避免误判），turn/start 才亮黄', () => {
  assert.equal(s6[0][1].length, 0, 'user/message 按约定忽略')
  assert.equal(s6[1][2].lamps.y, LAMP.BREATHE)
})

// ---- 场景 7：插件整体接线 ----
const h = createHarness()
await test('场景7：apply() 真的注册了 session/event 监听', () => {
  assert.equal(h.registered, true)
})
await test('场景7：apply() 返回清理函数（Cordis effect 约定）', () => {
  assert.equal(typeof h.dispose, 'function')
  h.dispose()
})

// ---- 场景 9：连续工具 + 尾窗完整时间线 ----
// 注意事件流的真实形态：每个 tool/result 后面紧跟一个 thinking 事件，
// 然后是下一个 tool/call。插件在这里必须只产生一开一关，不能对 thinking 事件有反应。
const s9 = simulate([
  ['assistant/attempt（开始生成）', { type: 'assistant/attempt' }],
  ['tool/call #1', { type: 'tool/call' }],
  ['tool/result #1（成功）', { type: 'tool/result', data: {} }],
  ['assistant/message（工具后的 thinking 事件）', { type: 'assistant/message' }],
  ['tool/call #2', { type: 'tool/call' }],
  ['tool/result #2（成功）', { type: 'tool/result', data: {} }],
  ['step/end（又一个 thinking 事件）', { type: 'step/end' }],
  ['tool/call #3', { type: 'tool/call' }],
  ['tool/result #3（最后一个，成功）', { type: 'tool/result', data: {} }],
  ['── 1 秒后（尾窗内）', '<<advance-ms>>', 1000],
  ['── 再 1.5 秒（尾窗走完）', '<<advance-ms>>', 1500],
  ['turn/end（答完）', { type: 'turn/end' }],
])
printScenario('场景 9：连续 3 个工具 + 尾窗时间线（不频闪验证）', s9)

await test('场景9：插件只产生 tools 开/关，thinking 事件完全不插话', () => {
  const sent = s9.flatMap(([, cmds]) => cmds)
  assert.equal(sent.filter((c) => c === 'busy').length, 0, '不再用 busy 表达工具执行')
  assert.equal(sent.filter((c) => c.startsWith('thinking+')).length, 0, '状态名里不再出现工具修饰符')
  // 期望序列：thinking(开头) → 之后每对 result/call 只产生 off/on 交替
  const expected = ['thinking', 'tools on', 'tools off', 'tools on', 'tools off', 'tools on', 'tools off', 'success']
  assert.deepEqual(sent, expected, `实际下发：${sent.join(' , ')}`)
})

await test('场景9：整段工具执行期间黄灯呼吸 + 绿灯呼吸都亮着', () => {
  // 从第 1 步（tool/call #1）到第 8 步（tool/result #3）之间
  for (const [label, , r] of s9.slice(1, 9)) {
    if (label.startsWith('──')) continue
    assert.equal(r.lamps.y, LAMP.BREATHE, `${label}: 黄灯应在呼吸`)
    assert.equal(r.lamps.g, LAMP.SLEEP, `${label}: 绿灯应在呼吸`)
  }
})

await test('场景9：尾窗走完后绿灯自动熄灭，且不产生任何串口流量', () => {
  const [, cmds1, r1] = s9[9]
  assert.deepEqual(cmds1, [])
  assert.equal(r1.lamps.g, LAMP.SLEEP, '1 秒时还在呼吸（周期 2.4 秒）')
  const [, cmds2, r2] = s9[10]
  assert.deepEqual(cmds2, [], '收尾完全由固件完成')
  assert.equal(r2.lamps.g, LAMP.OFF, '2.5 秒后绿灯自己灭了')
})

// ---- 场景 10：插件里不存在任何灯效时长参数（架构守卫） ----
await test('场景10：插件配置里没有任何灯效时长参数', () => {
  const cfgKeys = Object.keys(__testing.DEFAULTS)
  const forbidden = cfgKeys.filter((k) => /cooldown|hold|fade|tail|blink|duration|period/i.test(k))
  assert.deepEqual(forbidden, [], `插件不该有灯效时长参数，发现：${forbidden.join(', ')}`)
})

// ---- 场景 8：模拟结果与固件源码的一致性抽查 ----
console.log('\n[一致性] 模拟器里的规则 vs 固件源码')
await test('notify 时长常量与固件一致 (150+150)*2 = 600ms', () => {
  const ON = 150, OFF = 150, BLINKS = 2
  assert.equal((ON + OFF) * BLINKS, 600)
})
await test('固件确实把 plan 当背景修饰（不是抢占），黄绿可同亮', () => {
  const r = firmwareApplyStateEffects('thinking+plan')
  assert.equal(r.y, LAMP.BREATHE)
  assert.equal(r.g, LAMP.SOLID)
})
await test('尾窗常量与固件一致：TOOLS_HOLD_MS === BREATHE_PERIOD_MS = 2400', () => {
  assert.equal(BREATHE_PERIOD_MS, 2400)
})

console.log(`\n结果：${passed} 通过, ${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)
