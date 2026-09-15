/**
 * 决定性对比：用同一段真实 DSH 会话事件，分别喂给"旧盲计数逻辑"与"新 ID 配对逻辑"
 * ============================================================================
 *
 * 目的：证明修复真的解决了「绿灯永远不灭」。
 *
 * 旧逻辑（本文件内联复刻，就是修复前 plugin/lib/index.js 的算法）：
 *   tool/call +1，tool/result −1（夹到 0）
 * 新逻辑：直接 import 插件真实的 StateMachine。
 *
 * 两者都喂 DSH 真实日志里的事件，比对最后一条串口命令：
 *   停在 `tools on` → 绿灯会一直呼吸（bug）
 *   最后是 `tools off` → 固件会在一个呼吸周期后收尾（正确）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'
import { __testing } from '../plugin/lib/index.js'

const { StateMachine, DEFAULTS, EVENT_SETS, EVENT_TOPOLOGY } = __testing

// ---------------------------------------------------------------------------
// 读真实会话事件
// ---------------------------------------------------------------------------
function findLatestSession() {
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
  return found[0].p
}

const src = findLatestSession()
const text = decodeMultiFrameZstd(readFileSync(src)).text
const events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    const o = JSON.parse(line)
    const e = o.event?.type ? o.event : o.type ? o : null
    if (e && e.type) events.push(e)
  } catch {}
}
console.log(`真实会话：${events.length} 个事件`)
console.log(`${src}\n`)

// ---------------------------------------------------------------------------
// 旧的盲计数逻辑（修复前的算法，原样复刻以便对照）
// ---------------------------------------------------------------------------
function oldAlgorithm(events) {
  const RESULT = EVENT_SETS.RESULT
  const BUSY = EVENT_SETS.BUSY
  let activeTools = 0
  let toolsOn = false
  const sent = []
  for (const e of events) {
    const type = e.type
    if (type === 'turn/start' || type === 'turn/end' || type === 'session/end-seed') {
      // 旧版这些分支只在 success/off 里整块清，这里按旧版语义近似
    }
    if (RESULT.has(type)) {
      if (activeTools > 0) activeTools--
      if (activeTools === 0 && toolsOn) {
        toolsOn = false
        sent.push('tools off')
      }
      continue
    }
    if (BUSY.has(type)) {
      activeTools++
      if (!toolsOn) {
        toolsOn = true
        sent.push('tools on')
      }
    }
  }
  return { sent, activeTools, toolsOn }
}

// ---------------------------------------------------------------------------
// 新逻辑：跑插件真实代码
// ---------------------------------------------------------------------------
function newAlgorithm(events) {
  const sent = []
  const m = new StateMachine({ ...DEFAULTS }, { send: (c) => sent.push(c) }, () => {})
  for (const e of events) m.handle(e)
  return { sent, activeTools: m.activeCount, toolsOn: m.toolsReported, unmatched: m.unmatchedEnds, machine: m }
}

const oldR = oldAlgorithm(events)
const newR = newAlgorithm(events)

const summarize = (r) => ({
  'tools on': r.sent.filter((c) => c === 'tools on').length,
  'tools off': r.sent.filter((c) => c === 'tools off').length,
  末条命令: r.sent[r.sent.length - 1],
  残留未闭合并发数: r.activeTools,
  'toolsReported(绿灯呼吸中)': r.toolsOn,
})

console.log('=== 旧逻辑（盲计数 +1/−1，修复前）===')
for (const [k, v] of Object.entries(summarize(oldR))) console.log(`  ${k.padEnd(26)} ${v}`)
console.log('\n=== 新逻辑（按 callId 精确配对，修复后）===')
for (const [k, v] of Object.entries(summarize(newR))) console.log(`  ${k.padEnd(26)} ${v}`)
console.log(`  ${'未配对的收工事件'.padEnd(26)} ${newR.unmatched}（被安全忽略，不再带偏状态）`)

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------
console.log('\n=== 判定 ===')
const oldOk = oldR.toolsOn === false
const newOk = newR.toolsOn === false

if (!oldOk) {
  console.log(`  ❌ 旧逻辑：跑完 ${events.length} 个事件后仍以为有 ${oldR.activeTools} 个工具在跑`)
  console.log(`     → 永远不发 tools off → 绿灯一直呼吸不灭（这正是你看到的现象）`)
} else {
  console.log('  · 旧逻辑：这段事件流下恰好能归零（但真实长会话里会漂移）')
}
if (newOk) {
  console.log(`  ✅ 新逻辑：活动记录归零，末条命令 = ${newR.sent[newR.sent.length - 1]}`)
  console.log('     → 固件会在此后一个呼吸周期（2.4 秒）内把绿灯收干净')
} else {
  console.log(`  ❌ 新逻辑仍然残留 ${newR.activeTools} 个未闭合活动`)
}

// 逐轮核对：新逻辑在每个 turn/end 之后是否都归零
console.log('\n=== 新逻辑逐轮核对（每个 turn/end 之后活动数应为 0）===')
const m2 = new StateMachine({ ...DEFAULTS }, { send: () => {} }, () => {})
let turnNo = 0
let bad = 0
for (const e of events) {
  m2.handle(e)
  if (e.type === 'turn/end') {
    turnNo++
    if (m2.activeCount !== 0) {
      bad++
      console.log(`  ❌ turn#${turnNo} 结束后仍残留 ${m2.activeCount}`)
    }
  }
}
console.log(`  共 ${turnNo} 个 turn/end，残留次数 ${bad} ${bad === 0 ? '✅ 每次都归零' : '❌'}`)
