/**
 * 只读探针：确认串口占用状态
 * ============================================================================
 *
 * 用途：判断「正在运行的 DSH 里的 dsh-led-bridge 是否真的连上了板子」。
 *
 * 原理：
 *   1. 枚举串口 —— 找到 ESP32-C3（VID 303a / PID 1001）说明板子在，驱动正常。
 *   2. 尝试以独占方式打开：
 *        · 报 Access denied / 拒绝访问  → **插件正占着端口，说明它已加载并连上**（这是好结果）
 *        · 能打开                       → 插件没连上（DSH 没加载插件，或插件没找到板子）
 *
 * 它不会往板子写任何东西，也不会改变灯的状态。
 *
 * 跑法（必须在装有 serialport 的插件目录下）：
 *     cd ~/.dsh/plugins/dsh-led-bridge
 *     node <本文件路径>
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'package.json'))
const { SerialPort } = require('serialport')

const WANT_VID = '303a'
const WANT_PID = '1001'

const ports = await SerialPort.list()
console.log(`=== 串口枚举（共 ${ports.length} 个）===`)
let target = null
for (const p of ports) {
  const vid = (p.vendorId || '').toLowerCase()
  const pid = (p.productId || '').toLowerCase()
  const isEsp = vid === WANT_VID && pid === WANT_PID
  if (isEsp) target = p.path
  console.log(
    `  ${String(p.path).padEnd(10)} VID=${(p.vendorId || '-').padEnd(6)} PID=${(p.productId || '-').padEnd(6)}` +
      `  ${p.manufacturer || ''} ${isEsp ? '  ← ESP32-C3' : ''}`,
  )
}

if (!target) {
  console.log('\n❌ 没找到 ESP32-C3（VID 303a / PID 1001）——板子没插好或驱动有问题。')
  process.exit(2)
}

console.log(`\n找到目标板子: ${target}`)
console.log('尝试独占打开（不会写入任何数据）...')

const port = new SerialPort({ path: target, baudRate: 115200, autoOpen: false })

const result = await new Promise((resolve) => {
  port.open((err) => resolve(err || null))
})

if (result) {
  const msg = result.message || String(result)
  const denied = /access|denied|busy|permission|拒绝|占用/i.test(msg)
  console.log(`  打开失败: ${msg}`)
  if (denied) {
    console.log('\n✅ 端口被占用 —— 正在运行的 DSH 里的 dsh-led-bridge 已加载并连上了板子。')
    console.log('   （这是好结果：插件在工作，所以串口拿不到。）')
  } else {
    console.log('\n⚠️  打开失败但原因不是占用，需要进一步排查。')
  }
  process.exit(0)
} else {
  console.log('  打开成功 → 端口是空闲的')
  console.log('\n❌ 说明没有任何进程在用它 —— DSH 里的插件**没有**连上板子。')
  console.log('   可能原因：DSH 没加载插件 / 插件没找到串口 / 插件启动时报错。')
  port.close(() => process.exit(1))
}
