/**
 * 固件探针：确认板子上跑的是我们的固件，并且认我们的命令
 * ============================================================================
 *
 * 验收前跑这个。它回答三个问题：
 *   1. 板子在不在？（USB VID 303A / PID 1001）
 *   2. 串口有没有被别人占着？（占用说明 DSH 里还加载着插件）
 *   3. 固件认不认我们的命令？（发一条 off，看有没有 OK off 回执）
 *
 * 为什么发 off 而不是 thinking：off 让灯留在熄灭状态，不干扰后续验收观察。
 *
 * 跑法（必须在有 serialport 的目录下）：
 *   cd <仓库>\plugin && node ..\scripts\probe-firmware.mjs
 * 或先 pnpm install 再在本目录跑。
 *
 * 选项：
 *   --port COM3     指定端口（默认自动发现）
 *   --no-write      只读，不向板子发任何命令
 */

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

// serialport 装在 plugin/node_modules 里（它是插件的运行时依赖）。
// 这里显式从那里解析，避免"必须在某个特定 cwd 下跑"这种隐性要求。
const require = createRequire(join(REPO, 'plugin', 'package.json'))
let SerialPort
try {
  ;({ SerialPort } = require('serialport'))
} catch (e) {
  console.log('找不到 serialport 依赖。')
  console.log('先装依赖：  cd plugin && npm install')
  console.log(`原始错误：${e.message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
const portArgIdx = args.indexOf('--port')
const explicitPort = portArgIdx >= 0 ? args[portArgIdx + 1] : ''
const noWrite = args.includes('--no-write')

const WANT_VID = '303a'
const WANT_PID = '1001'

let failures = 0
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => {
  failures++
  console.log(`  FAIL ${m}`)
}
const note = (m) => console.log(`  --   ${m}`)

// ---------------------------------------------------------------------------
console.log('\n[1] 板子在不在')
// ---------------------------------------------------------------------------
const ports = await SerialPort.list()
console.log(`  枚举到 ${ports.length} 个串口：`)
for (const p of ports) {
  console.log(
    `    ${String(p.path).padEnd(10)} VID=${(p.vendorId || '-').padEnd(6)} PID=${(p.productId || '-').padEnd(6)} ${p.manufacturer || ''}`,
  )
}

let target = explicitPort
if (!target) {
  const match = ports.find(
    (p) => (p.vendorId || '').toLowerCase() === WANT_VID && (p.productId || '').toLowerCase() === WANT_PID,
  )
  target = match ? match.path : ''
}

if (!target) {
  bad(`没找到 ESP32-C3（VID ${WANT_VID} / PID ${WANT_PID}）。板子没插好，或驱动有问题。`)
  console.log('\n结论：环境未就位\n')
  process.exit(1)
}
if (explicitPort) note(`使用指定端口 ${target}`)
else ok(`自动发现 ESP32-C3：${target}`)

// ---------------------------------------------------------------------------
console.log('\n[2] 串口是否空闲')
// ---------------------------------------------------------------------------
const port = new SerialPort({ path: target, baudRate: 115200, autoOpen: false })

const openErr = await new Promise((resolve) => port.open((err) => resolve(err || null)))

if (openErr) {
  const msg = openErr.message || String(openErr)
  console.log(`    打开失败：${msg}`)
  if (/access|denied|busy|permission/i.test(msg)) {
    bad('端口被占用')
    console.log('        谁在占：DSH 里还加载着插件（改配置不会热卸载），或串口监视器开着。')
    console.log('        修法：在 DSH 里 dsh plugin --profile web remove dsh-led-bridge，然后重启 DSH。')
  } else {
    bad(`打开失败但原因不是占用：${msg}`)
  }
  console.log('\n结论：环境未就位\n')
  process.exit(1)
}
ok(`端口 ${target} 空闲，已成功打开`)

// ---------------------------------------------------------------------------
console.log('\n[3] 固件认不认我们的命令')
// ---------------------------------------------------------------------------
/** 读一段，返回收到的行 */
const readFor = (ms) =>
  new Promise((resolve) => {
    const lines = []
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (l) lines.push(l)
      }
    }
    port.on('data', onData)
    setTimeout(() => {
      port.off('data', onData)
      if (buf.trim()) lines.push(buf.trim())
      resolve(lines)
    }, ms)
  })

// 固件上电时只播一次 READY，所以现在读不到是正常的 —— 先如实说明
const idle = await readFor(800)
if (idle.length) {
  for (const l of idle) console.log(`    <- ${l}`)
  if (idle.some((l) => l.includes('READY'))) ok('看到固件握手行（ESP32_STATUS_LIGHT READY）')
  else note('有输出但没有 READY 行')
} else {
  note('空闲时无输出 —— 这是正常的（固件只在事件发生时发短包，READY 只在复位后播一次）')
}

if (noWrite) {
  note('--no-write：跳过命令探测')
} else {
  port.write('off\n')
  const ack = await readFor(2000)
  if (ack.length) {
    for (const l of ack) console.log(`    <- ${l}`)
    if (ack.some((l) => /OK\s+off/i.test(l))) {
      ok('固件回了 "OK off" —— 板上是我们的固件，且认得我们的命令')
    } else if (ack.some((l) => /ERR/i.test(l))) {
      bad('固件回了 ERR —— 它在听，但拒绝 off。板上可能烧的是别的 sketch。')
    } else {
      note('有输出但没有清晰的 OK/ERR，看上面的原文')
    }
  } else {
    bad('2 秒内没有收到 off 的回执')
    console.log('        要么固件没在跑，要么不是我们的固件。')
    console.log('        烧固件： powershell -File scripts\\build.ps1 -Upload')
  }
}

await new Promise((resolve) => port.close(() => resolve()))

console.log('')
if (failures === 0) {
  console.log('结论：环境就位 ✅  （探针发了 off，灯留在熄灭状态）\n')
  process.exit(0)
} else {
  console.log(`结论：有 ${failures} 项不通过 ❌\n`)
  process.exit(1)
}
