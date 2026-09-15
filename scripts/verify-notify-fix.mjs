/**
 * 回滚 bug 的端到端验证（不用肉眼看灯）
 * ============================================================================
 *
 * 验的东西：`notify` 闪烁窗口（600ms）内到达的新状态，闪完后有没有被回滚。
 *
 * 为什么这个版本才可信：早期版本靠"看灯"判断，反复出错 ——
 * 分不清"灯没亮"是命令没生效、被后续命令覆盖、还是人看错了。
 * 现在固件有 `state?` 诊断命令，每一步的内部状态都能读出来对照。
 *
 * 用例：
 *   C0 前提：每个状态命令单独发都能改掉 currentState
 *   C1 对照：notify 后不改状态        → 闪完应回到 notify 前的状态
 *   C2 关键：notify 后窗口内给新状态   → 闪完应**保持新状态**（不许回滚）
 *   C3 边界：窗口内给**同值**状态      → 应保持"回到闪烁前状态"的语义
 *
 * 跑法：node scripts/verify-notify-fix.mjs [--port COM3]
 * 前提：板子空闲（没有 DSH 插件占着串口）、且已烧含 state? 的固件。
 *
 * 依赖解析交给 _serial.mjs（它会找 repo/plugin、dist 产物、cwd，
 * 或环境变量 DSH_SERIALPORT_ANCHOR 指向的目录）。
 */

import { openBoard, fmtState, sleep } from './_serial.mjs'

const argv = process.argv.slice(2)
const portIdx = argv.indexOf('--port')
const PORT = portIdx >= 0 ? argv[portIdx + 1] : 'COM3'

let failures = 0
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => {
  failures++
  console.log(`  FAIL ${m}`)
}

let board
try {
  board = await openBoard(PORT)
} catch (e) {
  console.error(`打开 ${PORT} 失败：${e.message}`)
  console.error('  端口被占用的话：确认没有 DSH 插件或串口监视器持有它。')
  process.exit(1)
}
const { send, query, close } = board

console.log(`\n端口 ${PORT}\n`)

// ---------------------------------------------------------------------------
// C0 前提：state? 可用，且每个状态命令都能改变 state
// ---------------------------------------------------------------------------
console.log('[C0] 前提检查：state? 可用 + 各状态命令生效')

const probe = await query()
if (!probe.ok) {
  bad('固件没有响应 state? —— 板上可能还是不含该命令的旧固件')
  console.log('       ' + JSON.stringify(probe.raw))
  await close()
  process.exit(1)
}
ok(`state? 可用（当前 ${fmtState(probe)}）`)

const expected = [
  ['thinking', 'thinking'],
  ['error', 'error'],
  ['success', 'success'],
  ['alarm', 'alarm'],
  ['off', 'off'],
]
for (const [cmd, want] of expected) {
  await send(cmd, 500)
  const q = await query()
  if (q.ok && q.state === want) {
    ok(`\`${cmd}\` → state=${q.state}`)
  } else {
    bad(`\`${cmd}\` 应让 state=${want}，实际 ${q.ok ? q.state : JSON.stringify(q.raw)}`)
    console.log(`        这会让后续用例无法判断 —— 先解决这一条。`)
  }
}

// ---------------------------------------------------------------------------
// C1 对照：notify 后不改状态 → 闪完回到 notify 前的状态
// ---------------------------------------------------------------------------
console.log('\n[C1] 对照：notify 后**不**改状态')
await send('off', 700)
await send('thinking', 700)
console.log(`     起始：${fmtState(await query())}`)
await send('notify', 200)
console.log(`     闪中：${fmtState(await query())}`)
await sleep(1200)
const c1after = await query()
console.log(`     闪完：${fmtState(c1after)}`)
if (c1after.ok && c1after.state === 'thinking' && c1after.notify === false) {
  ok('C1 闪完回到闪烁前的 thinking（正常语义没被弄坏）')
} else {
  bad(`C1 闪完应是 thinking，实际 ${fmtState(c1after)}`)
}

// ---------------------------------------------------------------------------
// C2 关键：窗口内给新状态 → 闪完必须保持新状态
// ---------------------------------------------------------------------------
console.log('\n[C2] 关键：notify 后窗口内给 error')
await send('off', 700)
await send('thinking', 700)
const c2base = await query()
console.log(`     起始：${fmtState(c2base)}`)
const clearedBefore = c2base.ok ? c2base.savedCleared : 0

// ⚠️⚠️ notify 与 error 之间**绝不能插查询**，而且间隔要**明显小于**窗口。
//
// 两个坑，都实测踩过：
//   1. 中间插查询：一次 `state?` 要几百毫秒到几秒（要重试拆包），而窗口只有 600ms ——
//      error 到达时闪烁早就结束了。那条用例根本没撞上竞态，却因为"最终状态是 error"
//      而判为通过。**假阳性**：测的不是它声称要测的东西。快照作废计数器戳穿了它。
//   2. 间隔取 300ms：正好卡在 600ms 窗口的边界上，时快时慢，结果不稳定。
//      实测同一份固件两次跑出不同结果。取 150ms 让它明确落在窗口内。
const ackNotify = await send('notify', 150)
const ackErr = await send('error', 150)
console.log(`     notify 回执：${JSON.stringify(ackNotify)}`)
console.log(`     error  回执：${JSON.stringify(ackErr)}   （相隔 150ms，明确落在 600ms 窗口内）`)

await sleep(1500) // 等闪烁窗口彻底结束，且让所有回执都到齐
const c2after = await query()
console.log(`     闪完：${fmtState(c2after)}`)

if (c2after.ok && c2after.state === 'error' && c2after.lamps.R === 'SOLID') {
  ok('C2 闪完保持 error 且红灯常亮 —— 新状态没被回滚')
} else if (c2after.ok && c2after.state === 'thinking') {
  bad('C2 闪完被回滚成 thinking —— bug 仍在')
} else {
  bad(`C2 闪完应是 error/R=SOLID，实际 ${fmtState(c2after)}`)
}

// 用**累计计数器**证明"作废快照"那条路径确实被执行过 —— 这是唯一不受
// 查询耗时影响的证据（查询本身会破坏 600ms 窗口的时序）。
if (c2after.ok && c2after.savedCleared > clearedBefore) {
  ok(`C2 快照作废计数器增加了（${clearedBefore} → ${c2after.savedCleared}）—— 确认真的撞上了窗口且修复路径被执行`)
} else {
  bad(
    `C2 快照作废计数器没有增加（${clearedBefore} → ${c2after.ok ? c2after.savedCleared : '?'}）` +
      ` —— 这次没撞上 600ms 窗口（测试时序问题），或修复路径没跑到`,
  )
}

// ---------------------------------------------------------------------------
// C3 边界：窗口内给同值状态 → 不该作废快照
// ---------------------------------------------------------------------------
console.log('\n[C3] 边界：notify 后窗口内给**同值** thinking')
await send('off', 700)
await send('thinking', 700)
await send('notify', 300)
await send('thinking', 200)
const c3during = await query()
console.log(`     闪中：${fmtState(c3during)}`)
await sleep(1200)
const c3after = await query()
console.log(`     闪完：${fmtState(c3after)}`)
if (c3during.ok && c3during.saved === 'thinking') {
  ok('C3 同值命令没有作废快照（"回到闪烁前状态"语义保持）')
} else {
  bad(`C3 同值命令不该作废快照，实际 saved=${c3during.ok ? c3during.saved : '?'}`)
}

await send('off', 500)
await close()

console.log('')
if (failures === 0) {
  console.log('结果：全部通过 ✅\n')
  process.exit(0)
} else {
  console.log(`结果：${failures} 项失败 ❌\n`)
  process.exit(1)
}
