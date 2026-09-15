/**
 * 离线自测：不接板子、不连 DSH，纯逻辑验证。
 * ============================================================================
 *
 * 跑法：
 *     node scripts/selftest.mjs
 *
 * 它验证三件事：
 *   1. 事件 → 状态的映射表是否覆盖了我们认识的全部事件名；
 *   2. 失败判定 looksLikeFailure 是否只对真正的错误返回 true；
 *   3. 串口自动发现函数是否能在各种平台形态下正确挑出 ESP32-C3。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __testing } from '../plugin/lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const { EVENT_SETS, STATE, looksLikeFailure, pickPortPath, StateMachine, PLAN_MODE_EVENT, CMD_NOTIFY } = __testing

/**
 * 构造真实的工具事件，带配对用的 ID。
 *
 * 为什么测试也必须带 ID：插件早期用「call +1 / result −1」的盲计数配对，
 * 真机上 result 比 call 多，计数永远回不到 0，`tools off` 就永远不发、
 * 绿灯一直呼吸不灭。现在改成按 ID 精确配对，所以测试也必须用真实形态的事件，
 * 否则测不到真正的逻辑。
 */
let callSeq = 0
const newCallId = () => `call_test_${++callSeq}`

/** @param {string} [id] 不传则自动生成 */
function evCall(id = newCallId()) {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId: id, name: 'pwsh', arguments: '{}' } }
}

/** 构造与某个 call 配对的 tool/result（形态照抄真机：callId 在 message.source 里） */
function evResult(id, extra = {}) {
  return {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: id },
        content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text: 'ok' }] }],
      },
      ...extra,
    },
  }
}

/** 一次完整的工具调用：返回 [call, result] */
function evToolPair() {
  const id = newCallId()
  return [evCall(id), evResult(id)]
}

let passed = 0
let failed = 0

/**
 * 支持同步与异步两种用例。
 * @param {string} label
 * @param {() => unknown} fn
 */
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

console.log('\n[1] 事件映射表')

await test('thinking 覆盖模型工作的核心事件', () => {
  for (const e of ['step/start', 'step/end', 'assistant/attempt', 'assistant/message', 'turn/start']) {
    assert.ok(EVENT_SETS.THINKING.has(e), `缺少 ${e}`)
  }
})

await test('busy 覆盖工具执行类事件', () => {
  for (const e of ['tool/call', 'tool-workflow/run-start', 'command/run', 'compaction/start']) {
    assert.ok(EVENT_SETS.BUSY.has(e), `缺少 ${e}`)
  }
})

await test('alarm 只在等用户时触发，并配套清除事件', () => {
  assert.ok(EVENT_SETS.ALARM.has('approval/asked'))
  assert.ok(EVENT_SETS.ALARM_CLEAR.has('approval/decided'))
})

await test('success 在一轮结束时触发', () => {
  assert.ok(EVENT_SETS.SUCCESS.has('turn/end'))
})

await test('error 覆盖模型重试', () => {
  for (const e of ['llm/retry', 'llm/retry-started']) {
    assert.ok(EVENT_SETS.ERROR.has(e), `缺少 ${e}`)
  }
})

await test('映射表覆盖的事件名互不重叠', () => {
  const buckets = ['THINKING', 'BUSY', 'SUCCESS', 'OFF', 'RESULT', 'ERROR', 'ALARM', 'ALARM_CLEAR', 'NOTIFY_ONLY']
  const seen = new Map()
  for (const b of buckets) {
    for (const e of EVENT_SETS[b]) {
      assert.ok(!seen.has(e), `事件 ${e} 同时出现在 ${seen.get(e)} 和 ${b}`)
      seen.set(e, b)
    }
  }
  console.log(`       （共覆盖 ${seen.size} 个事件名）`)
})

await test('只闪一下的通知事件就是 goal/change 与 sandbox/mode', () => {
  assert.ok(EVENT_SETS.NOTIFY_ONLY.has('goal/change'))
  assert.ok(EVENT_SETS.NOTIFY_ONLY.has('sandbox/mode'))
  assert.equal(EVENT_SETS.NOTIFY_ONLY.size, 2)
})

await test('六个状态字与固件约定一致', () => {
  assert.deepEqual(
    Object.values(STATE).sort(),
    ['alarm', 'busy', 'error', 'off', 'success', 'thinking'],
  )
})

console.log('\n[2] 失败判定')

await test('明确的错误字段判为失败', () => {
  assert.equal(looksLikeFailure({ error: 'boom' }), true)
  assert.equal(looksLikeFailure({ isError: true }), true)
  assert.equal(looksLikeFailure({ failed: true }), true)
  assert.equal(looksLikeFailure({ status: 'error' }), true)
  assert.equal(looksLikeFailure({ status: 'FAILED' }), true)
  assert.equal(looksLikeFailure({ outcome: 'tool_error' }), true)
})

await test('正常结果不会被误判为失败', () => {
  assert.equal(looksLikeFailure({ status: 'ok' }), false)
  assert.equal(looksLikeFailure({ status: 'success' }), false)
  assert.equal(looksLikeFailure({ result: 'done' }), false)
  assert.equal(looksLikeFailure({}), false)
  assert.equal(looksLikeFailure(null), false)
  assert.equal(looksLikeFailure(undefined), false)
  assert.equal(looksLikeFailure('字符串'), false)
  assert.equal(looksLikeFailure(42), false)
})

await test('空字符串 error 不算失败（保守判断的边界）', () => {
  assert.equal(looksLikeFailure({ error: '' }), false)
})

console.log('\n[3] 串口自动发现')

/** 造一个假的 SerialPort 模块，只实现 list()。 */
const fakeList = (ports) => ({ list: async () => ports })

await test('Windows 形态：按 VID/PID 命中 ESP32-C3，跳过 CH340 和罗技接收器', async () => {
  const SerialPort = fakeList([
    { path: 'COM1', vendorId: '1a86', productId: '7523' },
    { path: 'COM7', vendorId: '303A', productId: '1001', manufacturer: 'Espressif' },
    { path: 'COM9', vendorId: '046d', productId: 'c53f' },
  ])
  const got = await pickPortPath(SerialPort, { vendorId: '303a', productId: '1001' }, () => {})
  assert.equal(got, 'COM7')
})

await test('VID/PID 大小写不敏感', async () => {
  const SerialPort = fakeList([{ path: 'COM12', vendorId: '303a', productId: '1001' }])
  const got = await pickPortPath(SerialPort, { vendorId: '303A', productId: '1001' }, () => {})
  assert.equal(got, 'COM12')
})

await test('找不到 Espressif 设备时返回 null（不乱连别人的串口）', async () => {
  const SerialPort = fakeList([
    { path: 'COM1', vendorId: '1a86', productId: '7523' },
    { path: 'COM9', vendorId: '046d', productId: 'c53f' },
  ])
  const got = await pickPortPath(SerialPort, { vendorId: '303a', productId: '1001' }, () => {})
  assert.equal(got, null)
})

await test('macOS 形态：拿不到 VID/PID 时按设备名兜底', async () => {
  const SerialPort = fakeList([{ path: '/dev/cu.usbmodem14201' }])
  const got = await pickPortPath(SerialPort, { vendorId: '303a', productId: '1001' }, () => {})
  assert.equal(got, '/dev/cu.usbmodem14201')
})

await test('用户显式指定串口时优先生效', async () => {
  const SerialPort = fakeList([{ path: 'COM7', vendorId: '303a', productId: '1001' }])
  const got = await pickPortPath(SerialPort, { port: 'COM99', vendorId: '303a', productId: '1001' }, () => {})
  assert.equal(got, 'COM99')
})

await test('枚举串口抛异常时不崩溃，返回 null', async () => {
  const SerialPort = { list: async () => { throw new Error('权限不足') } }
  const got = await pickPortPath(SerialPort, { vendorId: '303a', productId: '1001' }, () => {})
  assert.equal(got, null)
})

// ---------------------------------------------------------------------------
// [4] 状态机（计划模式 / 通知闪烁）
// ---------------------------------------------------------------------------

/** 假传输层：记录下发过的每一条命令。 */
function fakeTransport() {
  const sent = []
  return {
    sent,
    send(cmd) { sent.push(cmd) },
    last() { return sent[sent.length - 1] },
    clear() { sent.length = 0 },
  }
}

/** 造一个状态机实例（配置全默认，只是不需要真的串口）。 */
function machine() {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  return { m, t }
}

console.log('\n[4] 状态机：基础流转')

await test('thinking / tools / error / success 各自下发正确命令', () => {
  const { m, t } = machine()
  m.handle({ type: 'assistant/attempt' })
  assert.equal(t.last(), 'thinking')
  m.handle(evCall())
  // 工具是一个【独立命令】，不是状态名修饰符：
  // 前景保持 thinking（黄灯呼吸），另外单独上报「有工具在跑」。
  // 插件不关心这让灯长什么样 —— 渲染全归固件。
  assert.equal(t.last(), 'tools on')
  m.handle({ type: 'llm/retry' })
  assert.equal(t.last(), 'error')
  t.clear()
  m.handle({ type: 'turn/end' })
  assert.equal(t.last(), 'success')
})

await test('相同状态不重复下发（去重）', () => {
  const { m, t } = machine()
  m.handle({ type: 'step/start' })
  m.handle({ type: 'step/end' })
  m.handle({ type: 'assistant/message' })
  assert.deepEqual(t.sent, ['thinking'], '重复的 thinking 不该重复发')
})

await test('alarm 抢占，approval/decided 后回到 thinking', () => {
  const { m, t } = machine()
  m.handle(evCall())
  t.clear()
  m.handle({ type: 'approval/asked' })
  assert.equal(t.last(), 'alarm')
  m.handle(evCall())   // alarm 期间不应夺权
  assert.equal(t.last(), 'alarm')
  m.handle({ type: 'approval/decided' })
  assert.equal(t.last(), 'thinking')
})

console.log('\n[4b] 状态机：计划模式')

await test('进入计划模式：绿灯常亮（命令变成 plan）', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  assert.equal(t.last(), 'plan')
})

await test('计划模式 + 思考 → 黄灯呼吸 + 绿灯常亮（thinking+plan）', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  t.clear()
  m.handle({ type: 'assistant/attempt' })
  assert.equal(t.last(), 'thinking+plan', '绿灯必须保持，所以要带 +plan')
})

await test('计划模式 + 工具执行 → 状态是 thinking+plan，工具单独上报', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  t.clear()
  m.handle(evCall())
  // 计划模式仍然是状态名上的修饰符（它改变的是"前景该是什么"），
  // 而工具是独立事实。所以这里是两条命令，而不是一条混合命令。
  assert.deepEqual(t.sent, ['thinking+plan', 'tools on'])
  assert.equal(m.current, 'thinking+plan')
  assert.equal(m.toolsReported, true)
})

await test('计划模式 + 等确认 → alarm+plan（两个都保住）', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  m.handle({ type: 'approval/asked' })
  assert.equal(t.last(), 'alarm+plan')
})

await test('重复的 plan/mode active:true 不重复下发', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  t.clear()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  assert.equal(t.sent.length, 0)
})

await test('退出计划模式 → 绿灯快闪两下，闪完回到前景状态', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  m.handle({ type: 'assistant/attempt' })        // thinking+plan
  t.clear()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: false } })
  assert.equal(t.last(), `${CMD_NOTIFY} thinking`, '应是 notify + 闪完切到 thinking')
})

await test('计划模式下答完一轮 → 闪两下再保持绿灯常亮', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  t.clear()
  m.handle({ type: 'turn/end' })
  assert.equal(t.last(), `${CMD_NOTIFY} success+plan`, '闪完应回到 success+plan 常亮')
  assert.equal(m.current, 'success+plan')
})

await test('非计划模式下答完一轮 → 直接绿灯常亮，不闪', () => {
  const { m, t } = machine()
  m.handle({ type: 'turn/end' })
  assert.equal(t.last(), 'success')
})

console.log('\n[4c] 状态机：只闪不改状态的通知')

await test('goal/change → 绿灯快闪两下，状态与工具上报都不变', () => {
  const { m, t } = machine()
  m.handle(evCall())      // thinking + tools on
  t.clear()
  m.handle({ type: 'goal/change' })
  assert.equal(t.last(), CMD_NOTIFY, '不带参数 = 闪完回到之前状态')
  assert.equal(m.current, 'thinking', '状态本身不能变')
  assert.equal(m.toolsReported, true, '工具上报状态也不能被这次闪烁影响')
})

await test('sandbox/mode → 绿灯快闪两下，状态不变', () => {
  const { m, t } = machine()
  m.handle({ type: 'step/start' })     // thinking
  t.clear()
  m.handle({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
  assert.equal(t.last(), CMD_NOTIFY)
  assert.equal(m.current, 'thinking')
})

await test('计划模式下的 goal/change 闪完仍保持计划模式与工具状态', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  m.handle(evCall())      // thinking+plan + tools on
  t.clear()
  m.handle({ type: 'goal/change' })
  assert.equal(t.last(), CMD_NOTIFY)
  assert.equal(m.current, 'thinking+plan')
  assert.equal(m.toolsReported, true)
})

await test('session/end-seed 会同时清掉计划模式', () => {
  const { m, t } = machine()
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  m.handle({ type: 'session/end-seed' })
  assert.equal(t.last(), 'off')
  assert.equal(m.current, 'off')
})

await test('空闲自动灭灯已整体归固件：插件里不能再有这份实现', () => {
  // 这条锁住一个**删除**，不是新增功能，所以它检查的是「不存在」。
  //
  // 背景：插件曾有 idleTimeoutMs（默认 300000），与固件的 STALE_TIMEOUT_MS
  // 是同一件事的两份实现。那是错的：
  //   1. 它是个骗人的旋钮 —— 固件那份无条件生效，所以设成 0 或 ≥300000 都不起作用。
  //   2. 两者语义不同 —— 插件测「多久没有新状态」，固件测「多久没有串口活动」，
  //      于是长推理会被插件误灭灯。
  // 现在只剩固件那一份。
  const forbidden = ['idleTimeoutMs', 'idleTimer', 'armIdleTimer']
  const src = readFileSync(join(ROOT, 'plugin', 'lib', 'index.js'), 'utf8')
  // 去掉注释再看，否则历史说明里提到的名字会误伤
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n')
  for (const name of forbidden) {
    assert.ok(!code.includes(name), `插件代码里不该再有 ${name}（空闲灭灯归固件）`)
  }

  // 配置项也不能有，否则又是个骗人的旋钮
  assert.ok(!('idleTimeoutMs' in __testing.DEFAULTS), 'DEFAULTS 里不该再有 idleTimeoutMs')

  // 固件那边必须确实持有它 —— 否则就成了两边都没有，灯永远不灭
  const fwSrc = readFileSync(join(ROOT, 'firmware', 'esp32c3_dsh_status_light', 'esp32c3_dsh_status_light.ino'), 'utf8')
  assert.ok(/STALE_TIMEOUT_MS/.test(fwSrc), '固件必须持有 STALE_TIMEOUT_MS（唯一的空闲兜底）')
  assert.ok(
    /currentState\s*!=\s*"off"\s*&&\s*\(now\s*-\s*lastCommandMs\)\s*>\s*STALE_TIMEOUT_MS/.test(fwSrc),
    '固件里必须有真正执行这个超时的判断',
  )
})

console.log('\n[4d] 状态机：工具上报（只报事实，不做灯效时序）')

await test('tool/call → 前景 thinking + 独立上报 tools on', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle(evCall())
  assert.deepEqual(t.sent, ['thinking', 'tools on'])
  assert.equal(m.toolsReported, true)
  m.dispose()
})

await test('tool/result（最后一个工具）→ 立即上报 tools off，不带延迟', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  const [call, result] = evToolPair()
  m.handle(call)
  t.clear()
  m.handle(result)
  // 关键：插件【立即】上报，不等任何呼吸周期。绿灯的尾巴由固件负责走完。
  assert.deepEqual(t.sent, ['tools off'], '必须是立即上报，插件里不能有任何延时定时器')
  assert.equal(m.toolsReported, false)
  m.dispose()
})

await test('连续工具期间每对 call/result 只产生一开一关，thinking 事件不插话', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle({ type: 'assistant/attempt' })   // thinking
  m.handle(evCall())                        // tools on
  t.clear()
  // 真实事件流：工具结果之后紧跟一个 thinking 事件，然后再来下一个工具
  m.handle(evResult(`call_test_${callSeq}`))
  m.handle({ type: 'assistant/message' })   // ← 曾经就是它把绿灯掐掉的
  m.handle(evCall())
  m.handle(evResult(`call_test_${callSeq}`))
  m.handle({ type: 'step/end' })
  m.handle(evCall())
  assert.equal(m.current, 'thinking', '前景一直是 thinking')
  assert.equal(m.toolsReported, true, '工具状态一直是"在跑"')
  assert.deepEqual(
    t.sent,
    ['tools off', 'tools on', 'tools off', 'tools on'],
    '每对 result/call 只产生一开一关，thinking 事件不插话',
  )
  m.dispose()
})

await test('两个并发工具：只结束一个时不上报 off（按 ID 精确配对）', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  const [c1, r1] = evToolPair()
  const [c2] = evToolPair()
  m.handle(c1)
  m.handle(c2)              // 两个工具同时在跑
  t.clear()
  m.handle(r1)              // 只结束第一个
  assert.deepEqual(t.sent, [], '还有工具在跑，不该上报 off')
  assert.equal(m.toolsReported, true)
  m.dispose()
})

await test('收工事件比开工多也不会带偏状态（真机根因：result 比 call 多 10 个）', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  // 真机上 tool/result 会比 tool/call 多（command/done 等也算收工）。
  // 旧版盲计数会被这些多余的收工事件带偏；新版只认配对得上的 ID。
  for (let i = 0; i < 10; i++) m.handle(evResult('call_不存在的ID'))
  assert.equal(m.activeCount, 0, '配不上的收工事件不该产生任何残留')
  assert.equal(m.unmatchedEnds, 10, '应记录为未配对')
  t.clear()
  const [call, result] = evToolPair()
  m.handle(call)
  assert.deepEqual(t.sent, ['thinking', 'tools on'], '后续正常 call 不受影响')
  m.handle(result)
  assert.equal(m.toolsReported, false, '正常配对后必须能上报 off —— 这是绿灯会灭的保证')
  m.dispose()
})

await test('未闭合的 tool/call（等不到 result）会被轮次边界收掉', () => {
  // 真机实测：最后一个 tool/call 有时永远等不到配对 result，
  // 旧版会永远停在 tools on，绿灯一直呼吸不灭。
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle(evCall())
  assert.equal(m.toolsReported, true, '前置条件：工具在跑')
  assert.equal(m.activeCount, 1)
  t.clear()
  m.handle({ type: 'turn/end' })
  assert.equal(m.toolsReported, false, '轮次结束必须把残留的未闭合 call 清掉')
  assert.equal(m.activeCount, 0)
  assert.ok(t.sent.includes('tools off'), '应上报 tools off，绿灯才能收尾')
  m.dispose()
})

await test('turn/start 也会对账，清掉跨轮残留', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle(evCall())
  t.clear()
  m.handle({ type: 'turn/start' })
  assert.equal(m.toolsReported, false, '新一轮开始时应丢掉上一轮的残留')
  assert.deepEqual(t.sent, ['tools off'])
  m.dispose()
})

await test('thinking 事件不碰工具状态（这是真机踩到的频闪根因）', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle(evCall())
  assert.equal(m.toolsReported, true)
  t.clear()
  m.handle({ type: 'assistant/message' })   // thinking 类事件
  m.handle({ type: 'step/end' })
  assert.equal(m.toolsReported, true, 'thinking 事件不得清掉工具状态')
  assert.deepEqual(t.sent, [], '不该产生下发')
  m.dispose()
})

await test('工具失败 → 清掉工具状态并亮红灯', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  const [call] = evToolPair()
  m.handle(call)
  t.clear()
  const failId = `call_test_${callSeq}`
  m.handle(evResult(failId, { error: { name: 'E', code: 'X' } }))
  assert.deepEqual(t.sent, ['tools off', 'error'])
  assert.equal(m.current, 'error')
  m.dispose()
})

await test('没有配对的 result 事件不会产生任何残留', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  for (let i = 0; i < 3; i++) m.handle(evResult('call_孤立的'))
  t.clear()
  m.handle(evCall())
  assert.deepEqual(t.sent, ['thinking', 'tools on'], '孤立的 result 被忽略，这个 call 应正常上报')
  m.dispose()
})

await test('command/done 只关工具，【不】改前景状态（不许顺手改语义）', () => {
  // 这条锁住一个刻意的边界：修「工具计数」时不该顺带改「前景状态」的语义。
  // 我（AI）在重构时曾给 command/done 开特例，让它掉进 success 分支，
  // 于是 /compact 之类的斜杠命令结束时绿灯会常亮 —— 旧版本里它前景纹丝不动。
  // 那是对用户可见行为的擅自改动，已撤回，并用这条测试钉住。
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle({ type: 'assistant/attempt' })            // 前景 → thinking
  t.clear()
  m.handle({ type: 'command/done', data: { commandId: 'c1', kind: 'success', text: 'ok' } })
  assert.equal(m.current, 'thinking', 'command/done 不得把前景改成 success')
  assert.deepEqual(t.sent, [], '没有工具在跑时，command/done 不该产生任何下发')
  m.dispose()
})

await test('command/done 仍能正确关闭配对的 command/run', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle({ type: 'command/run', data: { commandId: 'c9', name: 'compact', source: { kind: 'user' } } })
  assert.equal(m.toolsReported, true, 'command/run 应算作"有活在跑"')
  t.clear()
  m.handle({ type: 'command/done', data: { commandId: 'c9', kind: 'success', text: 'done' } })
  assert.equal(m.toolsReported, false, 'command/done 应关掉它')
  assert.deepEqual(t.sent, ['tools off'], '按 commandId 配对后应上报 off，绿灯才能收尾')
  assert.equal(m.current, 'thinking', '前景不受影响')
  m.dispose()
})

await test('计划模式 + 工具：状态带 +plan，工具仍独立上报', () => {
  const t = fakeTransport()
  const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
  m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
  t.clear()
  const [call, result] = evToolPair()
  m.handle(call)
  assert.deepEqual(t.sent, ['thinking+plan', 'tools on'])
  m.handle(result)
  assert.equal(m.current, 'thinking+plan', '计划模式不受影响')
  assert.equal(m.toolsReported, false, '工具已结束')
  m.dispose()
})

await test('收尾 / 出错 / 等确认 都会清掉工具状态', () => {
  for (const [label, ev] of [
    ['session/end-seed', { type: 'session/end-seed' }],
    ['llm/retry', { type: 'llm/retry' }],
    ['approval/asked', { type: 'approval/asked', data: { id: 'a', toolName: 't' } }],
  ]) {
    const t = fakeTransport()
    const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
    m.handle(evCall())
    assert.equal(m.toolsReported, true, `${label}: 前置条件`)
    t.clear()
    m.handle(ev)
    assert.equal(m.toolsReported, false, `${label}: 应清掉工具状态`)
    m.dispose()
  }
})

await test('插件里不存在任何灯效时长参数（架构约束）', () => {
  // 这条是"插件只报事实"的守卫：一旦有人再往插件里塞渲染时序参数，这里会红。
  const cfgKeys = Object.keys(__testing.DEFAULTS)
  const forbidden = cfgKeys.filter((k) => /cooldown|hold|fade|tail|blink|duration|period/i.test(k))
  assert.deepEqual(forbidden, [], `插件不该有灯效时长参数，发现：${forbidden.join(', ')}`)
  assert.ok(!cfgKeys.includes('busyCooldownMs'), 'busyCooldownMs 应已移除')
})

await test('退出计划模式必须保留前景状态（尤其不能把 error 顶成 thinking）', () => {
  // 这条锁住两个容易写错的地方：
  //   1. 目标状态不带 +plan —— 退出后绿灯要恢复正常，不能继续常亮
  //   2. 目标状态要保留当时的前景 —— 早期版本在算目标之前就改了 #plan，
  //      如果重排顺序就可能把 error 当成 thinking，把"出错"闪没了
  for (const [setup, fg, label] of [
    [[{ type: 'llm/retry' }], 'error', '出错'],
    [[evCall()], 'thinking', '工具在执行'],
    [[{ type: 'turn/end' }], 'success', '答完'],
  ]) {
    const t = fakeTransport()
    const m = new StateMachine({ alarmTimeoutMs: 0 }, t, () => {})
    m.handle({ type: PLAN_MODE_EVENT, data: { active: true } })
    for (const ev of setup) m.handle(ev)
    t.clear()
    m.handle({ type: PLAN_MODE_EVENT, data: { active: false } })
    assert.equal(t.last(), `notify ${fg}`, `${label}: 退计划模式时应闪完切回 ${fg}`)
    m.dispose()
  }
})

console.log(`\n结果：${passed} 通过, ${failed} 失败\n`)
process.exit(failed === 0 ? 0 : 1)