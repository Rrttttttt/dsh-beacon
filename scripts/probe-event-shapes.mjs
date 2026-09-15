/**
 * 事件形态普查：每种「工具相关」事件的出现次数与嵌套结构
 * ============================================================================
 * 目的：为「按 callId 精确配对」的重写提供事实依据。
 * 特别是要弄清：
 *   - command/run 与 command/done 是否配对、主键在哪
 *   - hook/invoked 与 hook/result 是否配对
 *   - tool-workflow/* 的配对情况
 *   - compaction/start 与 compaction/end
 *   - 有没有事件里带 callId
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

// 汇总最近 5 个会话，样本更大
const EV = []
for (const f of found.slice(0, 5)) {
  try {
    const text = decodeMultiFrameZstd(readFileSync(f.p)).text
    for (const l of text.split('\n')) {
      if (!l.trim()) continue
      try {
        const o = JSON.parse(l)
        const e = o.event?.type ? o.event : o.type ? o : null
        if (e) EV.push(e)
      } catch {}
    }
  } catch {}
}
console.log(`汇总 ${found.slice(0, 5).length} 个会话，共 ${EV.length} 个事件\n`)

const INTEREST = [
  'tool/call',
  'tool/result',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool-workflow/run-start',
  'tool-workflow/run-end',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
  'command/run',
  'command/done',
  'hook/invoked',
  'hook/result',
  'compaction/start',
  'compaction/end',
  'compaction/prune',
  'compaction/summary',
]

const counts = new Map()
for (const e of EV) counts.set(e.type, (counts.get(e.type) || 0) + 1)

console.log('=== 感兴趣事件的出现次数 ===')
for (const t of INTEREST) {
  const n = counts.get(t) || 0
  console.log(`  ${String(n).padStart(6)}  ${t}`)
}

/** 深挖一个对象里所有 key 路径（找主键） */
function keyPaths(obj, prefix = '', out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return out
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    const v = obj[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) keyPaths(v, p, out, depth + 1)
    else if (Array.isArray(v)) {
      if (v[0] && typeof v[0] === 'object') keyPaths(v[0], `${p}[0]`, out, depth + 1)
      else out.push(p)
    } else out.push(p)
  }
  return out
}

console.log('\n=== 每种事件的首个样本 data 结构 ===')
for (const t of INTEREST) {
  const e = EV.find((x) => x.type === t)
  if (!e) {
    console.log(`\n--- ${t}: (本机日志里没出现过)`)
    continue
  }
  const paths = keyPaths(e.data || {})
  console.log(`\n--- ${t}`)
  console.log(`    data keys: ${paths.join(', ') || '(空)'}`)
  const j = JSON.stringify(e.data)
  console.log(`    样本: ${j.length > 400 ? j.slice(0, 400) + '…' : j}`)
}

// 专门找所有带 callId 的事件类型
console.log('\n=== 哪些事件类型里出现过 callId ===')
const withId = new Map()
for (const e of EV) {
  const s = JSON.stringify(e.data || {})
  if (/"callId"\s*:/.test(s)) {
    withId.set(e.type, (withId.get(e.type) || 0) + 1)
  }
}
for (const [t, n] of [...withId].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${t}`)
}

// command/run vs done 的配对能力
console.log('\n=== command 事件配对检查 ===')
const cruns = EV.filter((e) => e.type === 'command/run')
const cdone = EV.filter((e) => e.type === 'command/done')
console.log(`command/run=${cruns.length}  command/done=${cdone.length}`)
if (cruns[0]) console.log('command/run  data:', JSON.stringify(cruns[0].data).slice(0, 300))
if (cdone[0]) console.log('command/done data:', JSON.stringify(cdone[0].data).slice(0, 300))

console.log('\n=== hook 事件配对检查 ===')
const hi = EV.filter((e) => e.type === 'hook/invoked')
const hr = EV.filter((e) => e.type === 'hook/result')
console.log(`hook/invoked=${hi.length}  hook/result=${hr.length}`)
if (hi[0]) console.log('hook/invoked data:', JSON.stringify(hi[0].data).slice(0, 300))

console.log('\n=== compaction 配对检查 ===')
for (const t of ['compaction/start', 'compaction/end', 'compaction/prune', 'compaction/summary']) {
  console.log(`  ${t}: ${(counts.get(t) || 0)}`)
}

console.log('\n=== tool-workflow 配对检查 ===')
for (const t of [
  'tool-workflow/run-start',
  'tool-workflow/run-end',
  'tool-workflow/agent-start',
  'tool-workflow/agent-end',
]) {
  console.log(`  ${t}: ${(counts.get(t) || 0)}`)
}
