/**
 * 确认 tool/result 里 callId 的确切路径，并统计真实的 call/result 配对
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'

const root = join(homedir(), '.dsh', 'sessions')
const found = []
const walk = (d) => {
  for (const ent of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, ent.name)
    if (ent.isDirectory()) walk(p)
    else if (ent.name.startsWith('session.') && ent.name.includes('.jsonl'))
      found.push({ p, m: statSync(p).mtimeMs })
  }
}
walk(root)
found.sort((a, b) => b.m - a.m)

const text = decodeMultiFrameZstd(readFileSync(found[0].p)).text
const ev = []
for (const l of text.split('\n')) {
  if (!l.trim()) continue
  try {
    const o = JSON.parse(l)
    const e = o.event?.type ? o.event : o.type ? o : null
    if (e) ev.push(e)
  } catch {}
}

const calls = ev.filter((e) => e.type === 'tool/call')
const results = ev.filter((e) => e.type === 'tool/result')
console.log(`tool/call 数: ${calls.length}   tool/result 数: ${results.length}`)

const paths = [
  ['data.callId', (e) => e.data?.callId],
  ['data.message.source.callId', (e) => e.data?.message?.source?.callId],
  ['data.message.content[0].toolCallId', (e) => e.data?.message?.content?.[0]?.toolCallId],
  ['data.toolCallId', (e) => e.data?.toolCallId],
]
console.log('\n=== result 里 callId 的候选路径 ===')
for (const [nm, fn] of paths) {
  const vals = results.map(fn).filter((v) => v != null)
  console.log(`  ${nm.padEnd(36)} 命中 ${vals.length}/${results.length}   例: ${vals[0]}`)
}

const callIds = new Set(calls.map((c) => c.data?.callId).filter(Boolean))
const resIds = new Set(results.map((r) => r.data?.message?.source?.callId).filter(Boolean))
console.log(`\ncall   callId 唯一数: ${callIds.size}`)
console.log(`result callId 唯一数: ${resIds.size}`)
const unclosed = [...callIds].filter((id) => !resIds.has(id))
const orphan = [...resIds].filter((id) => !callIds.has(id))
console.log(`未闭合的 call: ${unclosed.length}   ${unclosed.length ? '← 这些会让绿灯一直亮' : ''}`)
console.log(`孤立的 result: ${orphan.length}`)

// 按 turn 统计未闭合
console.log('\n=== 按 turn 统计未闭合的 call ===')
const byTurn = new Map()
for (const c of calls) {
  const t = c.data?.turn ?? '?'
  if (!byTurn.has(t)) byTurn.set(t, { open: new Set(), res: new Set() })
  byTurn.get(t).open.add(c.data?.callId)
}
for (const r of results) {
  const t = r.data?.turn ?? '?'
  if (!byTurn.has(t)) byTurn.set(t, { open: new Set(), res: new Set() })
  byTurn.get(t).res.add(r.data?.message?.source?.callId)
}
for (const [t, v] of [...byTurn].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  const left = [...v.open].filter((id) => !v.res.has(id))
  const flag = left.length ? `  ❌ 未闭合 ${left.length}: ${left[0]}` : '  ✅'
  console.log(`  turn ${String(t).padStart(3)}  call=${v.open.size} result=${v.res.size}${flag}`)
}
