/**
 * 取证脚本：解压 DSH 的会话事件日志，检查工具计数能否配对
 * ============================================================================
 *
 * 背景问题：
 *   真机观察到「跑完一批工具后，绿灯一直亮着不熄」。
 *   固件侧逻辑已确认正确（收到 tools off 后 2.4 秒收尾），
 *   所以怀疑点在插件侧：#activeTools 计数可能永远回不到 0，
 *   于是 #reportTools() 永远不发 `tools off`，绿灯就一直呼吸。
 *
 * 本脚本解码 DSH 自己写的 zstd JSONL 事件日志（Node 24 原生支持 zstd），
 * 按时间顺序统计 tool/call 与 tool/result，并模拟插件的配对规则。
 *
 * 用法：
 *   node scripts/probe-events.mjs                    # 自动取最新会话
 *   node scripts/probe-events.mjs <session.v3.jsonl.zstd>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'

/** 与插件 lib/index.js 保持一致的集合（只挑与工具计数有关的）。 */
const RESULT_EVENTS = new Set([
  'tool/result',
  'tool-workflow/run-end',
  'tool-workflow/agent-end',
  'command/done',
  'hook/result',
])
const BUSY_EVENTS = new Set([
  'tool/call',
  'tool-workflow/run-start',
  'tool-workflow/agent-start',
  'command/run',
  'compaction/start',
])

function findLatestSession() {
  const root = join(homedir(), '.dsh', 'sessions')
  const found = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.startsWith('session.') && ent.name.includes('.jsonl'))
        found.push({ p, m: statSync(p).mtimeMs })
    }
  }
  walk(root)
  found.sort((a, b) => b.m - a.m)
  if (!found.length) throw new Error('找不到会话日志')
  return { path: found[0].p, mtime: found[0].m }
}

const arg = process.argv[2]
const latest = findLatestSession()
const target = arg || latest.path
console.log(`会话日志: ${target}`)
console.log(`最后写入: ${new Date(latest.mtime).toLocaleString('zh-CN')}\n`)

const raw = readFileSync(target)
const dec = decodeMultiFrameZstd(raw)
const text = dec.text
console.log(`zstd 帧: ${dec.frames}（成功 ${dec.ok} / 失败 ${dec.bad}）`)

const lines = text.split('\n').filter((l) => l.trim())
console.log(`解压后 ${lines.length} 行，${(text.length / 1024 / 1024).toFixed(2)} MB\n`)

const events = []
for (const line of lines) {
  try {
    const o = JSON.parse(line)
    // 事件可能被包一层，{type:'session/event', event:{...}} 或直接是事件
    if (o.type === 'session/event' && o.event) events.push(o.event)
    else if (o.event && o.event.type) events.push(o.event)
    else if (o.type) events.push(o)
  } catch {
    /* 跳过无法解析的行 */
  }
}
console.log(`解析出 ${events.length} 个事件\n`)

const counts = new Map()
for (const e of events) counts.set(e.type, (counts.get(e.type) || 0) + 1)
console.log('=== 事件类型统计（前 25）===')
for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(5)}  ${t}`)
}

// ---- 模拟插件的工具计数 ----
console.log('\n=== 模拟插件工具计数 ===')
let active = 0
let calls = 0
let results = 0
let reportedOn = false
const transitions = []

for (const e of events) {
  const t = e.type
  if (BUSY_EVENTS.has(t)) {
    calls++
    active++
    if (!reportedOn) {
      reportedOn = true
      transitions.push({ when: e.time ?? e.timestamp ?? e.at, what: 'tools on', active })
    }
  } else if (RESULT_EVENTS.has(t)) {
    results++
    if (active > 0) active--
    if (active === 0 && reportedOn) {
      reportedOn = false
      transitions.push({ when: e.time ?? e.timestamp ?? e.at, what: 'tools off', active })
    }
  }
}

console.log(`  call  类事件:  ${calls}`)
console.log(`  result 类事件: ${results}`)
console.log(`  差值:          ${calls - results}`)
console.log(
  `  最终 active:   ${active}   ${active > 0 ? '❌ 回不到 0 → 插件永远不会发 tools off' : '✅ 归零'}`,
)

console.log('\n=== 插件会发出的 tools on/off 序列 ===')
if (!transitions.length) console.log('  (没有产生任何上报)')
for (const tr of transitions) {
  const ts =
    typeof tr.when === 'number' ? new Date(tr.when).toISOString().slice(11, 23) : String(tr.when)
  console.log(`  ${ts}  ${tr.what.padEnd(9)} (active=${tr.active})`)
}

console.log('\n=== 最后 25 条工具相关事件 ===')
const related = events.filter((e) => BUSY_EVENTS.has(e.type) || RESULT_EVENTS.has(e.type))
for (const e of related.slice(-25)) {
  const w = e.time ?? e.timestamp
  const ts = typeof w === 'number' ? new Date(w).toISOString().slice(11, 23) : String(w ?? '?')
  const nm = e.data?.name ?? e.data?.tool ?? e.data?.toolName ?? ''
  const err = e.data?.error || e.data?.isError === true ? ' ERR' : ''
  console.log(`  ${ts}  ${String(e.type).padEnd(22)} ${nm}${err}`)
}

// ---- 关键：检查每个 turn 内 call/result 的配对 ----
console.log('\n=== 按 turn 看配对（找有没有漏掉的 result）===')
let turnIdx = 0
let perTurn = { call: 0, result: 0 }
for (const e of events) {
  if (e.type === 'turn/start') {
    if (turnIdx > 0) console.log(`  turn#${turnIdx}: call=${perTurn.call} result=${perTurn.result} ${perTurn.call !== perTurn.result ? '❌ 不配对' : '✅'}`)
    turnIdx++
    perTurn = { call: 0, result: 0 }
  }
  if (BUSY_EVENTS.has(e.type)) perTurn.call++
  if (RESULT_EVENTS.has(e.type)) perTurn.result++
}
if (turnIdx > 0) console.log(`  turn#${turnIdx}(最后/未结束): call=${perTurn.call} result=${perTurn.result}`)
