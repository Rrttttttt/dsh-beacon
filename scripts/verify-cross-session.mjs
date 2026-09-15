/**
 * 跨会话严格核对：插件是否会在任何「已结束的轮次」留下未闭合活动
 * ============================================================================
 *
 * 这是对「绿灯永远不灭」这个真机 bug 的最终验证。
 *
 * 判定标准（很关键，别搞错）：
 *   ✅ turn/end 之后活动数必须为 0 —— 轮次已结束，不该还有"工具在跑"
 *   ✅ 会话最后一个 turn 若还没 turn/end，允许残留（工具真的在跑，绿灯该亮）
 *   ❌ 已结束的轮次里残留任何活动 = 绿灯会一直呼吸不灭
 *
 * 同时统计"未配对的收工事件"数量，确认它们被安全忽略而不是把状态带偏。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'
import { __testing } from '../plugin/lib/index.js'

const { StateMachine, DEFAULTS } = __testing

const root = join(homedir(), '.dsh', 'sessions')
const sessions = []
const walk = (d) => {
  for (const ent of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, ent.name)
    if (ent.isDirectory()) walk(p)
    else if (ent.name.startsWith('session.') && ent.name.includes('.jsonl'))
      sessions.push({ p, m: statSync(p).mtimeMs, size: statSync(p).size })
  }
}
walk(root)
sessions.sort((a, b) => b.m - a.m)

const LIMIT = Number(process.argv[2] || 12)
console.log(`核对最近 ${LIMIT} 个会话\n`)

let totalTurns = 0
let totalBadTurns = 0
let totalUnmatched = 0
let totalEvents = 0
const rows = []

for (const s of sessions.slice(0, LIMIT)) {
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
  totalEvents += events.length

  const m = new StateMachine({ ...DEFAULTS }, { send: () => {} }, () => {})
  let turns = 0
  let bad = 0
  let lastWasTurnEnd = false
  for (const e of events) {
    m.handle(e)
    if (e.type === 'turn/end') {
      turns++
      lastWasTurnEnd = true
      if (m.activeCount !== 0) bad++
    } else if (e.type === 'turn/start' || e.type === 'user/message') {
      lastWasTurnEnd = false
    }
  }
  totalTurns += turns
  totalBadTurns += bad
  totalUnmatched += m.unmatchedEnds

  const residual = m.activeCount
  const finalClosed = lastWasTurnEnd
  rows.push({
    会话: s.p.split('session-')[1]?.slice(0, 8) ?? '?',
    事件: events.length,
    轮次: turns,
    已结束轮次残留: bad,
    '末轮进行中残留': finalClosed ? 0 : residual,
    未配对收工: m.unmatchedEnds,
  })
}

console.log('=== 每个会话 ===')
const hdr = Object.keys(rows[0])
console.log('  ' + hdr.map((h) => h.padEnd(16)).join(''))
for (const r of rows) {
  console.log('  ' + hdr.map((h) => String(r[h]).padEnd(16)).join(''))
}

console.log('\n=== 汇总 ===')
console.log(`  会话数:                     ${rows.length}`)
console.log(`  事件总数:                   ${totalEvents}`)
console.log(`  turn/end 总数:              ${totalTurns}`)
console.log(`  已结束轮次仍有残留的次数:   ${totalBadTurns}   ${totalBadTurns === 0 ? '✅ 绿灯不会卡住' : '❌ 有轮次漏发 tools off'}`)
console.log(`  未配对的收工事件总数:       ${totalUnmatched}（被安全忽略，不参与计数）`)

if (totalBadTurns === 0) {
  console.log('\n✅ 结论：所有已结束的轮次都能正确回到"无工具在跑"，绿灯不会永远亮着。')
  console.log('   仍在呼吸 = 确实有工具正在执行（或该轮尚未结束），这是正确行为。')
} else {
  console.log('\n❌ 结论：仍有已结束的轮次残留活动，绿灯会卡住。')
  process.exit(1)
}
