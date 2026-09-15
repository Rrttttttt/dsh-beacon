/**
 * 回放取证：把真实会话事件灌进插件的真实 StateMachine，打印它发出的每条串口命令
 * ============================================================================
 *
 * 这是「灯到底该怎样」的权威答案：不猜、不模拟，直接跑真代码。
 *
 * 做法：import 插件真实的 StateMachine，用一个记录型的假 transport 接住所有
 *       send()，然后把 DSH 的会话事件按时间顺序喂进去，逐条打印。
 *
 * 用法：
 *   node scripts/replay-session.mjs                # 最新会话，全部事件
 *   node scripts/replay-session.mjs --tail 400     # 只看最后 400 个事件
 *   node scripts/replay-session.mjs --around 12:53 # 只看本地时间 12:5x 附近
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decodeMultiFrameZstd } from './zstd-frames.mjs'
import { __testing } from '../plugin/lib/index.js'

const { StateMachine, DEFAULTS } = __testing

const args = process.argv.slice(2)
const tailIdx = args.indexOf('--tail')
const wantTail = tailIdx >= 0 ? Number(args[tailIdx + 1]) : 0
const aroundIdx = args.indexOf('--around')
const wantAround = aroundIdx >= 0 ? args[aroundIdx + 1] : ''

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
  return found[0].p
}

const src = findLatestSession()
console.log(`会话: ${src}\n`)

const text = decodeMultiFrameZstd(readFileSync(src)).text
let events = []
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  try {
    const o = JSON.parse(line)
    const e = o.type === 'session/event' && o.event ? o.event : o.event?.type ? o.event : o
    if (e && e.type) events.push(e)
  } catch {}
}

if (wantTail > 0) events = events.slice(-wantTail)

// ---- 记录型假 transport ----
const sent = []
const transport = {
  send(cmd) {
    sent.push({ t: Date.now(), cmd })
  },
}

const logs = []
const machine = new StateMachine({ ...DEFAULTS }, transport, (m) => logs.push(m))

// ---- 回放 ----
const started = Date.now()
for (const e of events) machine.handle(e)
const elapsed = Date.now() - started

// ---- 输出 ----
console.log(`回放 ${events.length} 个事件，耗时 ${elapsed}ms\n`)
console.log(`=== 插件发出的串口命令序列（共 ${sent.length} 条）===`)
const fmt = (ms) =>
  ms > 0 && ms < 1e12 ? new Date(ms).toISOString().slice(11, 23) : '??'
for (let i = 0; i < sent.length; i++) {
  const s = sent[i]
  const gap = i > 0 ? s.t - sent[i - 1].t : 0
  console.log(`  ${String(i + 1).padStart(4)}  (+${String(gap).padStart(4)}ms)  ${s.cmd}`)
}

console.log(`\n=== 插件日志（共 ${logs.length} 条）===`)
for (const l of logs.slice(-30)) console.log('  ' + l)

// ---- 关键判定 ----
const toolCmds = sent.filter((s) => s.cmd.startsWith('tools'))
console.log(`\n=== 工具命令统计 ===`)
console.log(`  tools on : ${toolCmds.filter((s) => s.cmd === 'tools on').length}`)
console.log(`  tools off: ${toolCmds.filter((s) => s.cmd === 'tools off').length}`)

const last = sent[sent.length - 1]
console.log(`\n最后一条命令: ${last ? last.cmd : '(无)'}`)
if (last && last.cmd === 'tools on') {
  console.log('  ❌ 回放结束时停在 tools on —— 绿灯会一直呼吸（这正是真机现象）')
} else if (last && last.cmd === 'tools off') {
  console.log('  ✅ 回放结束时是 tools off —— 固件会在 2.4 秒后收尾')
}
console.log(`\n最终 current = ${machine.current}`)
console.log(`最终 toolsReported = ${machine.toolsReported}`)
