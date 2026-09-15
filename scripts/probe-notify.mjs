/**
 * 抓 notify 期间固件的真实行为
 * ============================================================================
 *
 * 背景：发 `notify success` 时串口回了 `OK notify success` 和 `OK notify -> success`，
 * 说明固件的两阶段逻辑跑完了；但用户没看到闪烁。必须定位差在哪：
 *   A) 闪烁分支根本没执行（逻辑问题）
 *   B) 闪烁执行了但时间太短 / 时机不对（参数问题）
 *
 * 做法：发命令后以 ~50ms 间隔轮询串口，把每一条回执连同相对时间打出来。
 * 固件在 notify 开始和结束各打印一行，所以两行之间的间隔就是真实的闪烁窗口。
 *
 * 跑法：node scripts/probe-notify.mjs [命令]
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(join(HERE, '..', 'plugin', 'package.json'))
const { SerialPort } = await import(pathToFileURL(require.resolve('serialport')).href)

const WANT_VID = '303a'
const WANT_PID = '1001'
const cmd = process.argv[2] || 'notify success'
const totalMs = Number(process.argv[3]) || 2500

const ports = await SerialPort.list()
const hit = ports.find(
  (p) => (p.vendorId || '').toLowerCase() === WANT_VID && (p.productId || '').toLowerCase() === WANT_PID,
)
if (!hit) {
  console.error('未找到 ESP32-C3')
  process.exit(3)
}

const sp = new SerialPort({ path: hit.path, baudRate: 115200, autoOpen: false })
const events = []
let buf = ''
const t0 = Date.now()

sp.on('data', (d) => {
  buf += d.toString()
  // 按行切开，把完整的行带时间戳记下来
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r/g, '').trim()
    buf = buf.slice(idx + 1)
    if (line) events.push({ t: Date.now() - t0, line })
  }
})

await new Promise((res, rej) => sp.open((err) => (err ? rej(err) : res())))
await new Promise((r) => setTimeout(r, 400))
buf = ''

console.log(`串口: ${hit.path}`)
console.log(`下发: ${cmd}`)
console.log('')
sp.write(cmd + '\n')

await new Promise((r) => setTimeout(r, totalMs))
sp.close(() => {})

console.log('时刻(ms)  固件输出')
console.log('---------  --------------------------------')
for (const e of events) {
  console.log(`${String(e.t).padStart(7)}ms  ${e.line}`)
}

// 解析出 notify 窗口
const start = events.find((e) => /OK notify\s/.test(e.line) && !/->/.test(e.line))
const end = events.find((e) => /OK notify ->/.test(e.line))
console.log('')
if (start && end) {
  const window = end.t - start.t
  console.log(`notify 窗口: ${start.t}ms → ${end.t}ms = ${window}ms`)
  console.log(`固件常量算出应为: (150 + 150) * 2 = 600ms`)
  console.log(
    window >= 550 && window <= 700
      ? '✅ 闪烁窗口长度与设计一致 —— 说明闪烁代码确实执行了，问题在“看不看得见”'
      : `❌ 窗口是 ${window}ms，与 600ms 不符 —— 时序逻辑有问题`,
  )
} else if (start) {
  console.log('⚠️  看到 notify 开始，但没等到 "->" 结束行（可能等太短）')
} else {
  console.log('⚠️  没有抓到 notify 回执行 —— 命令可能没被识别')
}
