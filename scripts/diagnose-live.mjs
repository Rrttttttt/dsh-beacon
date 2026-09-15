/**
 * 现场诊断：在真机上跑插件的真实 apply()
 * ============================================================================
 *
 * 用途：区分「插件代码本身跑不起来」和「插件没问题、只是 DSH 里没加载/没抢到串口」。
 *       这是排查「灯不跟随状态」时最有用的第一步。
 *
 * 做法：用假的 ctx（只实现 ctx.on / ctx.logger）调用真实的 apply()，
 *       把真实日志打出来，看它能不能连上 ESP32-C3。
 *
 * ⚠️ 它会真的去开串口。如果 dsh-led-bridge 正在被 DSH 用着，
 *    这里会报「拒绝访问」—— 那本身就是"插件正常工作"的证据，不是错误。
 *
 * 跑法（必须在装有 serialport 依赖的插件目录里跑）：
 *     工程内：   node <本文件路径>   —— 不行，工程 plugin/ 里才有 node_modules
 *     推荐：     cd <插件安装目录>
 *                node <插件安装目录>/scripts/diagnose-live.mjs
 *
 * 依赖解析说明：本文件 import '../lib/index.js'，所以必须和 lib/ 同级放置。
 * 因此 git 版本放在工程 scripts/ 下仅供参考，实际要用拷贝到插件的 scripts/ 里。
 */

import { apply, name } from '../lib/index.js'

console.log(`插件名: ${name}`)

const logs = []
const listeners = new Map()

const ctx = {
  logger: {
    info: (m) => {
      logs.push(m)
      console.log('  [插件日志] ' + m)
    },
  },
  on(event, handler) {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  },
}

let disposer
try {
  disposer = apply(ctx, { reconnectIntervalMs: 3000 })
  console.log('\napply() 调用成功，未抛异常')
} catch (err) {
  console.log('\n❌ apply() 抛异常了：', err && err.message)
  process.exit(1)
}

console.log(`注册的监听器: ${[...listeners.keys()].join(', ') || '(无)'}`)
console.log('等待 9 秒看它能不能连上串口...\n')

await new Promise((r) => setTimeout(r, 9000))

const connected = logs.some((l) => l.includes('已连接'))
const notFound = logs.some((l) => l.includes('未发现'))
const loadFail = logs.some((l) => l.includes('未安装 serialport'))
const parserFail = logs.some((l) => l.includes('缺少 ReadlineParser'))
const connFail = logs.filter((l) => l.includes('连接失败'))

console.log('\n=== 判定 ===')
if (connected) {
  console.log('  ✅ 插件代码完全正常：成功连上了 ESP32-C3')
  console.log('     → 那 DSH 里没连上就不是代码问题，检查 DSH 是否重启过')
} else if (loadFail) {
  console.log('  ❌ serialport 装不上 —— 依赖问题')
} else if (parserFail) {
  console.log('  ❌ serialport 缺少 ReadlineParser —— 依赖损坏，重装')
} else if (connFail.length) {
  console.log('  ⚠️  尝试连接但失败：')
  for (const l of connFail) console.log('     ' + l)
  console.log('     → 若报"拒绝访问"，说明串口被别的进程占了（可能 DSH 里的插件正在用）')
} else if (notFound) {
  console.log('  ⚠️  枚举不到 ESP32-C3（VID 303a / PID 1001）')
} else {
  console.log('  ⚠️  日志里没有任何连接相关记录，插件可能卡在别处')
}

if (typeof disposer === 'function') {
  console.log('\n调用清理函数...')
  disposer()
  console.log('  清理完成')
}
process.exit(0)
