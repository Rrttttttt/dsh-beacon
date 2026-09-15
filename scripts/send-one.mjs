/**
 * 单条命令发送器 —— 验证灯语用
 * ============================================================================
 *
 * 为什么是「一条一条」：一次性把 10 条命令发完，人眼来不及把每条和预期对上，
 * 验证等于没做。所以这个脚本一次只做一件事：发一条命令、报板子的回执，
 * 然后退出，由调用方去问用户看到了什么。
 *
 * 它会先读一段静默期，把板子在此之前吐出来的东西（例如上电握手）一并带回，
 * 避免"回执到底是这条命令的还是上一条的"这种混乱。
 *
 * 跑法：
 *     node scripts/send-one.mjs <命令> [等待毫秒数]
 *     node scripts/send-one.mjs "notify success" 1500
 *     node scripts/send-one.mjs --read 3000        (只读不发)
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * serialport 装在 plugin/node_modules 里，而本脚本在 scripts/ 下 ——
 * Node 的模块解析只会从脚本所在目录往上找，找不到兄弟目录的 node_modules。
 * 所以显式指向插件的依赖，避免为了跑个验证脚本再装一份。
 */
const require = createRequire(join(HERE, '..', 'plugin', 'package.json'))
const { SerialPort } = await import(pathToFileURL(require.resolve('serialport')).href)

const args = process.argv.slice(2)
const readOnly = args[0] === '--read'

/** 目标串口。板子固定是 Espressif 原生 USB（VID 303A / PID 1001）。 */
const WANT_VID = '303a'
const WANT_PID = '1001'

async function findPort() {
  const ports = await SerialPort.list()
  const hit = ports.find(
    (p) => (p.vendorId || '').toLowerCase() === WANT_VID && (p.productId || '').toLowerCase() === WANT_PID,
  )
  return hit ? hit.path : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cmd = readOnly ? null : args[0]
const afterMs = Number(readOnly ? args[1] : args[1]) || 1200

if (!readOnly && !cmd) {
  console.error('用法: node scripts/send-one.mjs <命令> [等待毫秒]')
  process.exit(2)
}

const path = await findPort()
if (!path) {
  console.error('未找到 ESP32-C3（VID 303a / PID 1001）。板子插好了吗？')
  process.exit(3)
}

const sp = new SerialPort({ path, baudRate: 115200, autoOpen: false })
let buf = ''

sp.on('data', (d) => {
  buf += d.toString()
})

await new Promise((res, rej) => sp.open((err) => (err ? rej(err) : res())))

// 打开串口的瞬间会触发板子复位（DTR/RTS），所以先静默期把噪声排掉
await sleep(300)
buf = ''

if (!readOnly) {
  sp.write(cmd + '\n')
}

await sleep(afterMs)
sp.close(() => {})

const lines = buf.split(/[\r\n]+/).filter(Boolean)
const ack = lines.find((l) => l.startsWith('OK') || l.startsWith('ERR')) || null

console.log(JSON.stringify({
  port: path,
  sent: cmd,
  ack,
  allLines: [...new Set(lines)],
}, null, 2))

process.exit(0)
