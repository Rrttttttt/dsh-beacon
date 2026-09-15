/**
 * 串口工具：依赖解析 + 命令收发 + 状态查询
 * ============================================================================
 *
 * 为什么单独抽出来：
 *   同一段"找 serialport、开端口、发命令、解析 state? 输出"的逻辑，我在
 *   `lamp-check.mjs` 与 `verify-notify-fix.mjs` 里各写了一遍，而且**写错过好几次**：
 *     - 用绝对路径硬引另一个工程的 node_modules（换台机器就废）
 *     - 把 USB CDC 拆包的一个完整行当成两行，解析失败
 *   抽成一处，错一次就够了。
 *
 * 依赖解析顺序（都不要求调用方在特定 cwd 下跑）：
 *   1. 环境变量 DSH_SERIALPORT_ANCHOR 指向的目录
 *   2. 本仓库 plugin/          （源码树装了依赖时）
 *   3. 本仓库 dist/.../plugin/ （打包产物里带了依赖树时）
 *   4. 当前工作目录
 *   都没有就给出明确指引，而不是抛一个 MODULE_NOT_FOUND。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 载入 serialport，失败时打印可操作的指引后退出 */
export function loadSerialPort() {
  const anchors = [
    process.env.DSH_SERIALPORT_ANCHOR && join(process.env.DSH_SERIALPORT_ANCHOR, 'package.json'),
    join(REPO_ROOT, 'plugin', 'package.json'),
    join(REPO_ROOT, 'dist', 'dsh-led-bridge', 'plugin', 'package.json'),
    join(process.cwd(), 'package.json'),
  ].filter(Boolean)

  const tried = []
  for (const anchor of anchors) {
    try {
      const mod = createRequire(anchor)('serialport')
      if (mod && mod.SerialPort) return mod
    } catch {
      tried.push(anchor)
    }
  }

  console.error('找不到 serialport 依赖。试过这些位置：')
  for (const t of tried) console.error('  ' + t)
  console.error('')
  console.error('修法（任选）：')
  console.error('  1) 在本仓库装依赖：   cd plugin && npm install')
  console.error('  2) 指向已装好的目录： set DSH_SERIALPORT_ANCHOR=<含 node_modules 的目录>')
  process.exit(2)
}

/**
 * 打开串口并返回一个带收发方法的句柄。
 *
 * @param {string} path 例如 'COM3'
 * @returns {Promise<{send: (cmd: string, wait?: number) => Promise<string[]>,
 *                    query: (attempts?: number) => Promise<object>,
 *                    close: () => Promise<void>}>}
 */
export async function openBoard(path) {
  const { SerialPort } = loadSerialPort()
  const sp = new SerialPort({ path, baudRate: 115200, autoOpen: false })

  let pending = []
  sp.on('data', (d) => {
    d
      .toString('utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((l) => pending.push(l))
  })

  const drain = () => {
    const o = pending.slice()
    pending = []
    return o
  }

  await new Promise((resolve, reject) => sp.open((e) => (e ? reject(e) : resolve())))

  /** 发一条命令，等回执行 */
  const send = async (cmd, wait = 500) => {
    drain()
    sp.write(cmd + '\n')
    await sleep(wait)
    return drain()
  }

  /**
   * 发 `state?` 并解析。
   *
   * ⚠️ 解析方式必须容忍**行内任意位置被拆包**。
   *
   * 实测 USB CDC 的拆包位置完全随机，见过这些形态：
   *     ["STATE", "off | plan=0 ..."]              ← 行首拆开
   *     ["STATE think", "ing | plan=0 ..."]        ← 单词中间拆开
   *     ["STATE error | plan=", "0 tools=0 ..."]   ← 字段中间拆开
   * 早期实现按"行"匹配（findIndex 找以 'STATE ' 开头的行），于是这些**全被判成解析失败**，
   * 进而把完全正常的数据报成"固件没响应 state?" —— 实测它把我引向了完全错误的方向，
   * 浪费了大量时间。任何按“行/词/字段”切分的假设都是错的。
   *
   * 正确做法：把所有收到的文本拼成一条流，直接在其中匹配两个已知格式的字段。
   * 响应格式是固定的（固件里写死的），所以标记之间的正则是可靠的。
   */
  const query = async (attempts = 6) => {
    let stream = ''
    for (let i = 0; i < attempts; i++) {
      sp.write('state?\n')
      await sleep(500)
      // 行间加空格，避免上一行末尾与下一行开头黏在一起
      stream += drain().join(' ') + ' '

      const m = /STATE (\S+) \| plan=(\d) tools=(\d) notify=(\d) saved=(\S+) after=(\S+) savedcleared=(\d+)/.exec(
        stream,
      )
      const lm = /LAMPS Y=(\S+) G=(\S+) R=(\S+)/.exec(stream)
      if (m && lm) {
        return {
          ok: true,
          state: m[1],
          plan: m[2] === '1',
          tools: m[3] === '1',
          notify: m[4] === '1',
          saved: m[5],
          after: m[6],
          savedCleared: Number(m[7]),
          lamps: { Y: lm[1], G: lm[2], R: lm[3] },
        }
      }
      await sleep(250)
    }
    return { ok: false, raw: stream.trim().slice(0, 300) }
  }

  const close = () => new Promise((r) => sp.close(() => r()))

  return { send, query, close }
}

/** 把 query() 的结果格式化成一行，便于打印 */
export function fmtState(q) {
  if (!q || !q.ok) return `(查询失败 ${JSON.stringify(q && q.raw)})`
  return `state=${q.state} notify=${q.notify ? 1 : 0} saved=${q.saved} after=${q.after} savedcleared=${q.savedCleared} | Y=${q.lamps.Y} G=${q.lamps.G} R=${q.lamps.R}`
}
