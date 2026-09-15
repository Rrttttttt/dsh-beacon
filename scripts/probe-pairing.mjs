/**
 * 检查 tool/call 与 tool/result 的配对标识
 * ============================================================================
 * 目的：找出插件应该用哪个字段把 result 关联回 call。
 * 当前插件用「计数器 +1 / -1」的盲配对，实测 result 比 call 多 9 个，
 * 计数永远不会归零，于是永远不会发 tools off，绿灯一直呼吸。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'

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
const text = decodeMultiFrameZstd(readFileSync(found[0].p)).text

const events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    const o = JSON.parse(line)
    const e = o.type === 'session/event' && o.event ? o.event : o.event?.type ? o.event : o
    if (e.type) events.push(e)
  } catch {}
}

// 1) 打印一条完整的 tool/call 与 tool/result，看全字段
const aCall = events.find((e) => e.type === 'tool/call')
const aResult = events.find((e) => e.type === 'tool/result')
console.log('=== 一条 tool/call 完整内容 ===')
console.log(JSON.stringify(aCall, null, 2).slice(0, 2000))
console.log('\n=== 一条 tool/result 完整内容 ===')
console.log(JSON.stringify(aResult, null, 2).slice(0, 2000))

// 2) 找出所有可能的主键字段名
const idField = (e) => {
  const d = e.data || {}
  return (
    d.toolCallId ?? d.callId ?? d.toolUseId ?? d.id ?? d.tool_call_id ?? e.toolCallId ?? e.callId ?? null
  )
}
console.log('\n=== 主键字段探测 ===')
console.log('call 的 id 样例:', events.filter((e) => e.type === 'tool/call').slice(0, 5).map(idField))
console.log('result 的 id 样例:', events.filter((e) => e.type === 'tool/result').slice(0, 5).map(idField))

// 3) 用 id 做真正的配对
const calls = events.filter((e) => e.type === 'tool/call')
const results = events.filter((e) => e.type === 'tool/result')
const callIds = new Map()
for (const c of calls) {
  const id = idField(c)
  if (id != null) callIds.set(String(id), (callIds.get(String(id)) || 0) + 1)
}
const resultIds = new Map()
for (const r of results) {
  const id = idField(r)
  if (id != null) resultIds.set(String(id), (resultIds.get(String(id)) || 0) + 1)
}
console.log(`\ncall 里有 id 的: ${callIds.size} / ${calls.length}`)
console.log(`result 里有 id 的: ${resultIds.size} / ${results.length}`)

const orphanResults = [...resultIds.keys()].filter((k) => !callIds.has(k))
const orphanCalls = [...callIds.keys()].filter((k) => !resultIds.has(k))
console.log(`孤立 result（没有对应 call）: ${orphanResults.length}`)
console.log(`孤立 call（没有对应 result）: ${orphanCalls.length}`)

// 4) 用「id 集合」模拟正确的配对逻辑
console.log('\n=== 用 id 集合模拟（正确做法）===')
const open = new Set()
let onCount = 0
let offCount = 0
for (const e of events) {
  if (e.type === 'tool/call') {
    const id = idField(e)
    const wasEmpty = open.size === 0
    open.add(String(id))
    if (wasEmpty) onCount++
  } else if (e.type === 'tool/result') {
    const id = idField(e)
    if (open.has(String(id))) {
      open.delete(String(id))
      if (open.size === 0) offCount++
    }
    // 找不到对应 call 的 result：忽略，不动计数
  }
}
console.log(`  tools on  次数: ${onCount}`)
console.log(`  tools off 次数: ${offCount}`)
console.log(`  结束时未闭合的 call: ${open.size} ${open.size === 0 ? '✅' : '⚠️'}`)
if (open.size) console.log('  未闭合 id:', [...open].slice(0, 10))
