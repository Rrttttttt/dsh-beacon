/**
 * 确定性 zip 写入器：同一棵目录树永远产出同样的字节
 * ============================================================================
 *
 * 为什么不用 `Compress-Archive`：
 *   它在 PS 5.1 与 PS 7 下写出的字节**不同**（版本元数据、字段取值有差异），
 *   于是 `powershell -File scripts/pack.ps1`（README 教用户跑的）与 CI 的
 *   `shell: pwsh` 产出的 zip SHA256 不一致 —— 想核对下载包的人会以为包被污染。
 *   实测：两者解压后 202 个文件**内容全部相同**，但整包哈希不同。
 *
 *   同样的坑还有 `ConvertTo-Json`（见 scripts/write-json.ps1）。
 *
 * 本模块把所有会变的量都钉死：
 *   - 条目顺序：按路径排序（不依赖文件系统遍历顺序）
 *   - 时间戳：固定成一个常量（zip 的 DOS 时间戳）
 *   - 权限位：固定 0644 / 目录 0755
 *   - 压缩：对每个条目现算 CRC32，用 deflate level 9
 *   - 不写 extra field、不写注释、不写平台相关的 creator 字段差异
 *
 * 只实现"存文件 / 存目录"这两种，够打包用。
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'

/** 固定时间戳：2020-01-01 00:00:00，DOS 格式能表达且非零 */
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 收集条目
// ---------------------------------------------------------------------------

/**
 * 递归收集一个目录下的所有条目（目录在前、文件在后，整体按路径排序）。
 * @param {string} rootDir
 * @returns {{rel: string, abs: string, isDir: boolean}[]}
 */
function collect(rootDir) {
  const out = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      const rel = relative(rootDir, abs).split(sep).join('/')
      if (ent.isDirectory()) {
        out.push({ rel: rel + '/', abs, isDir: true })
        walk(abs)
      } else if (ent.isFile()) {
        out.push({ rel, abs, isDir: false })
      }
      // 符号链接不打包（产物里不该有）
    }
  }
  walk(rootDir)
  // 排序：让顺序与文件系统遍历顺序无关
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

// ---------------------------------------------------------------------------
// 写 zip
// ---------------------------------------------------------------------------

/**
 * 把一个目录打成确定性 zip。
 *
 * @param {string} rootDir 要打包的目录（它的**内容**会成为 zip 顶层，不含自身名）
 * @param {string} outPath 输出 zip 路径
 * @returns {{entries: number, bytes: number}}
 */
export function zipDirectory(rootDir, outPath) {
  const items = collect(rootDir)

  const chunks = [] // 本地文件头 + 数据
  const central = [] // 中央目录记录
  let offset = 0

  for (const item of items) {
    const nameBuf = Buffer.from(item.rel, 'utf8')
    const isDir = item.isDir

    let raw = Buffer.alloc(0)
    let method = 0 // 0 = stored
    let comp = Buffer.alloc(0)

    if (!isDir) {
      raw = readFileSync(item.abs)
      // 目录和空文件用 stored；其余 deflate。固定 level 9 保证字节稳定。
      const deflated = deflateRawSync(raw, { level: 9 })
      // 压缩后反而更大时用 stored —— 判定也必须是确定性的（比大小即可）
      if (deflated.length < raw.length) {
        method = 8
        comp = deflated
      } else {
        method = 0
        comp = raw
      }
    }

    const crc = isDir ? 0 : crc32(raw)
    const compSize = comp.length
    const rawSize = isDir ? 0 : raw.length

    // 外部属性：目录 0755，文件 0644（左移 16 位放进高字节，与 Info-ZIP 一致）
    const external = isDir ? (0o40755 << 16) >>> 0 : (0o100644 << 16) >>> 0

    // ---- 本地文件头 ----
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0) // 签名
    lh.writeUInt16LE(20, 4) // 需要版本 2.0
    lh.writeUInt16LE(0, 6) // 通用标志位（不设 bit 11，名字已是 utf8 且不含非 ASCII）
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(DOS_TIME, 10)
    lh.writeUInt16LE(DOS_DATE, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(compSize, 18)
    lh.writeUInt32LE(rawSize, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28) // extra 长度

    chunks.push(lh, nameBuf, comp)

    // ---- 中央目录记录 ----
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // 制作版本：UNIX(3) + 2.0
    cd.writeUInt16LE(20, 6) // 需要版本
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(DOS_TIME, 12)
    cd.writeUInt16LE(DOS_DATE, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(compSize, 20)
    cd.writeUInt32LE(rawSize, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra
    cd.writeUInt16LE(0, 32) // 注释
    cd.writeUInt16LE(0, 34) // 起始磁盘
    cd.writeUInt16LE(0, 36) // 内部属性
    cd.writeUInt32LE(external, 38)
    cd.writeUInt32LE(offset, 42)

    central.push(cd, nameBuf)

    offset += lh.length + nameBuf.length + comp.length
  }

  const centralBuf = Buffer.concat(central)
  const localBuf = Buffer.concat(chunks)

  // ---- 中央目录结束记录 ----
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // 本磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  const out = Buffer.concat([localBuf, centralBuf, eocd])
  writeFileSync(outPath, out)
  return { entries: items.length, bytes: out.length }
}

// 允许直接跑：node _zip.mjs <目录> <输出.zip>
if (process.argv[1] && process.argv[1].endsWith('_zip.mjs')) {
  const [, , dir, out] = process.argv
  if (!dir || !out) {
    console.error('用法: node scripts/_zip.mjs <目录> <输出.zip>')
    process.exit(2)
  }
  const r = zipDirectory(dir, out)
  console.log(`已写出 ${out}：${r.entries} 个条目，${r.bytes} 字节`)
}
