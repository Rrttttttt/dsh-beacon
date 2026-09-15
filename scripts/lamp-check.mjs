/**
 * 灯效对照工具：把指定的命令轮流跑一遍，每条按住几秒，方便你逐个确认
 * ============================================================================
 *
 * 用途：当"灯不亮"或"颜色对不上"时，把问题拆成最原始的一步 —— 单独发一条命令，
 * 盯住灯看。不要把它和"事件时序"混在一起测，那样出了问题分不清是哪个环节。
 *
 * 为什么写成文件而不是 `node -e`：内联脚本里的中文引号/嵌套引号反复
 * 把 PowerShell 与 Node 的解析器搞崩（踩过好几次）。文件里没有这个风险。
 *
 * 跑法：
 *   cd <仓库>\plugin        （serialport 在这里）
 *   node ..\scripts\lamp-check.mjs error alarm success
 *   node ..\scripts\lamp-check.mjs thinking --hold 6000
 *   node ..\scripts\lamp-check.mjs            （默认跑 error / alarm / success）
 *
 * 参数：
 *   <命令...>        要依次发送的命令（默认 error alarm success）
 *   --hold <毫秒>    每条命令按住多久（默认 5000）
 *   --port <端口>    默认 COM3
 *   --no-clear       每条之间不插入 off（默认会插入，避免残留干扰判断）
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// serialport 是插件的运行时依赖，装在 plugin/node_modules 或 dist 产物里。
// 显式从这两个位置解析，避免"必须在某个特定 cwd 下跑"这种隐性要求。
function loadSerialPort() {
  const candidates = [
    join(ROOT, 'plugin', 'package.json'),
    join(ROOT, 'dist', 'dsh-led-bridge', 'plugin', 'package.json'),
  ]
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor)
      return req('serialport')
    } catch {
      /* 试下一个 */
    }
  }
  console.error('找不到 serialport 依赖。先装依赖：cd plugin && npm install')
  process.exit(2)
}

const { SerialPort } = loadSerialPort()

// ---- 解析参数 ----
const argv = process.argv.slice(2)
const cmds = []
let holdMs = 5000
let port = 'COM3'
let clearBetween = true

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--hold') holdMs = Number(argv[++i]) || 5000
  else if (a === '--port') port = argv[++i] || 'COM3'
  else if (a === '--no-clear') clearBetween = false
  else if (!a.startsWith('--')) cmds.push(a)
}
if (cmds.length === 0) cmds.push('error', 'alarm', 'success')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

const p = new SerialPort({ path: port, baudRate: 115200, autoOpen: false })
let buf = ''
p.on('data', (d) => {
  buf += d.toString('utf8')
})

p.open(async (err) => {
  if (err) {
    console.error(`打开 ${port} 失败：${err.message}`)
    console.error('  端口被占用的话：确认没有 DSH 插件或串口监视器持有它。')
    process.exit(1)
  }

  const send = async (cmd, wait = 450) => {
    buf = ''
    p.write(cmd + '\n')
    await sleep(wait)
    return buf.trim().replace(/\s+/g, ' ') || '(无回执)'
  }

  console.log('')
  console.log(`端口 ${port}   每条按住 ${holdMs} ms   命令：${cmds.join(' , ')}`)
  console.log('请只记【亮的是哪个物理位置】，不用管颜色名字。')
  console.log('')

  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]
    console.log('--------------------------------------------------')
    console.log(`  ${stamp()}  第 ${i + 1}/${cmds.length} 条：${cmd}`)
    const ack = await send(cmd)
    console.log(`  ${stamp()}  回执：${ack}`)
    console.log(`  ${stamp()}  ★ 请看灯：哪一颗亮？怎么亮（常亮/呼吸/闪）？`)
    await sleep(holdMs)
    console.log(`  ${stamp()}  ---- 本条结束 ----`)
    if (clearBetween && i < cmds.length - 1) {
      await send('off')
      await sleep(1200)
    }
  }

  console.log('')
  console.log('收尾：off')
  await send('off')
  p.close(() => process.exit(0))
})
