/**
 * 极简归档读取器：不依赖外部 tar/unzip，也不需要子进程
 * ============================================================================
 *
 * 为什么自己写这个：
 *   `verify-dist.mjs` 早先用 `execFileSync('tar', ...)` 读 zip / tgz 内容。
 *   在禁止管道子进程的环境里（受限沙箱、加固的 CI 镜像）这会抛 EPERM，
 *   于是三项检查被误报成 FAIL —— 而产物其实是好的。
 *
 *   与其加降级分支，不如**根本不开子进程**：zip 和 tar.gz 都是简单格式，
 *   用 Node 自带能力就能读。
 *     - tar.gz：`zlib.gunzipSync` + 解析 512 字节的 tar 头
 *     - zip   ：解析中央目录（central directory）
 *
 * 本文件只实现只读的"列举条目"和"取某个条目内容"，够产物验证用。
 */

import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// gzip + tar
// ---------------------------------------------------------------------------

/**
 * 读一个 .tar.gz，返回条目列表。
 * @param {string} path
 * @returns {{name: string, size: number, type: string}[]}
 */
export function listTarGz(path) {
  return parseTar(gunzip(readFileSync(path)))
}

/**
 * 从 .tar.gz 里取一个条目的文本内容。
 * @param {string} path
 * @param {string} entryName 例如 'package/package.json'
 * @returns {string|null} 找不到返回 null
 */
export function readTarGzText(path, entryName) {
  const buf = gunzip(readFileSync(path))
  for (const e of parseTar(buf, true)) {
    if (e.name === entryName) return buf.subarray(e.dataStart, e.dataStart + e.size).toString('utf8')
  }
  return null
}

function gunzip(buf) {
  // 同步解压：产物只有几 MB，不值得为异步增加复杂度
  return gunzipSync(buf)
}

/**
 * 解析 tar 缓冲区。
 *
 * 格式要点：每个条目以一个 512 字节头开始，头里 name 在 0..100、size 在 124..136
 * （八进制 ASCII）。数据跟在头后面，按 512 对齐补齐。名字为空表示归档结束。
 *
 * @param {Buffer} buf
 * @param {boolean} [withDataStart] 是否记录数据偏移（取内容时需要）
 */
function parseTar(buf, withDataStart = false) {
  const entries = []
  let off = 0
  while (off + 512 <= buf.length) {
    const name = cstr(buf, off, 100)
    if (name === '') break // 结束标记：一个全零块

    const sizeStr = cstr(buf, off + 124, 12).trim()
    const size = sizeStr ? parseInt(sizeStr, 8) : 0
    const typeFlag = String.fromCharCode(buf[off + 156]) || '0'
    const prefix = cstr(buf, off + 345, 155) // POSIX ustar 的长路径前缀

    const fullName = prefix ? `${prefix}/${name}` : name
    const entry = { name: fullName, size, type: typeFlag }
    if (withDataStart) entry.dataStart = off + 512
    entries.push(entry)

    // 数据长度按 512 向上取整
    off += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

/** 读一个以 NUL 结尾的定长字符串 */
function cstr(buf, start, len) {
  const slice = buf.subarray(start, start + len)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

/**
 * 读一个 .zip，返回条目名列表（只解析中央目录，够列举用）。
 *
 * 为什么只读中央目录：条目名、大小都在那里，不需要解压任何数据。
 * 中央目录的位置从文件尾的 EOCD（End Of Central Directory，签名 0x06054b50）拿。
 *
 * @param {string} path
 * @returns {string[]}
 */
export function listZip(path) {
  const buf = readFileSync(path)

  // 从尾部往前找 EOCD（注释最长 65535，所以最多回退 64KB+22）
  const EOCD_SIG = 0x06054b50
  const minPos = Math.max(0, buf.length - 65557)
  let eocd = -1
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('不是有效的 zip（找不到 EOCD）')

  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  const names = []
  let p = cdOffset
  const CD_SIG = 0x02014b50
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) break
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    names.push(name.replace(/\\/g, '/'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return names
}
