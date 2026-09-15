/**
 * 确定性 tar.gz 写入器：同一棵目录树永远产出同样的字节
 * ============================================================================
 *
 * 为什么不用 `pnpm pack`：
 *   它是 zip 那条路（Compress-Archive）的同类问题 —— 产物字节受环境影响的
 *   因素不由我们控制（gzip 头里的 OS 字节、pnpm/npm 版本、条目顺序等）。
 *   实测：本地 `pnpm pack` 连续两次稳定，但 **CI 打出的 tgz 与本机不同**
 *   （2026 字节级差异，CI 20837 vs 本地 20226）。而我在本机无法复现 CI 的
 *   差异 —— 复现不了的东西就没法验证，所以不该把"可核对"寄托在它身上。
 *
 *   既然要可复现，就自己钉死每一个字节：
 *     - 条目顺序：按路径排序，不依赖遍历顺序
 *     - tar 的 mtime / uid / gid / uname / gname：全部固定
 *     - 文件模式：固定 0644，目录 0755
 *     - gzip：固定 compression level 9、OS 字节 255（未知），
 *       MTIME 用**固定的非零值** FIXED_MTIME
 *       （⚠️ 不能是 0：`mtime: 0` 会让 zlib 省略 MTIME 字段，而 npm 的归档解析器
 *        要求该字段存在 —— 写 0 会导致 `npm install` 报 TAR_BAD_ARCHIVE）
 *     - tar magic 写在**偏移 257**：写成 157（linkname 字段）会让 npm 退回
 *       GNU tar 语义、把空 linkname 判成 "linkpath forbidden" 而拒绝整包
 *     - 格式：ustar 前缀写法（路径 >100 字符时自动用 prefix 字段）
 *
 * 产出 npm 期望的结构：所有内容放在 `package/` 前缀下。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

/** 固定的 mtime：1985-10-26（tar 传统上用来表示"无时间戳"的值） */
const FIXED_MTIME = 499162500
const UID = 0
const GID = 0
const UNAME = ''
const GNAME = ''
const FILE_MODE = 0o644
const DIR_MODE = 0o755

/** 把字符串写进 tar 头的定长字段 */
function writeStr(buf, offset, value, length) {
  const b = Buffer.from(value, 'utf8')
  if (b.length > length) throw new Error(`tar 字段溢出（${value} 需要 ${b.length} > ${length}）`)
  b.copy(buf, offset)
}

/** 八进制数值字段：前导零、以 NUL 结尾 */
function writeOct(buf, offset, value, length) {
  const s = value.toString(8).padStart(length - 1, '0') + '\0'
  writeStr(buf, offset, s, length)
}

/** 校验和字段：先填空格，算完再以 6 位八进制 + NUL + 空格 写回 */
function writeChecksum(buf) {
  writeStr(buf, 148, '        ', 8)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += buf[i]
  const s = sum.toString(8).padStart(6, '0') + '\0 '
  writeStr(buf, 148, s, 8)
}

/**
 * 构造一个 tar 头。路径过长时按 ustar 规范拆进 prefix 字段。
 */
function tarHeader(name, size, { isDir = false } = {}) {
  const buf = Buffer.alloc(512)
  let path = name
  let prefix = ''

  if (Buffer.byteLength(path, 'utf8') > 100) {
    // 从后往前找能放进 prefix(155) 的切分点，name 部分不超过 100
    const parts = path.split('/')
    for (let i = parts.length - 1; i > 0; i--) {
      const tail = parts.slice(i).join('/')
      const head = parts.slice(0, i).join('/')
      if (Buffer.byteLength(tail, 'utf8') <= 100 && Buffer.byteLength(head, 'utf8') <= 155) {
        path = tail
        prefix = head
        break
      }
    }
    if (Buffer.byteLength(path, 'utf8') > 100) throw new Error(`tar 路径太长，无法拆分：${name}`)
  }

  writeStr(buf, 0, path, 100)
  writeOct(buf, 100, isDir ? DIR_MODE : FILE_MODE, 8)
  writeOct(buf, 108, UID, 8)
  writeOct(buf, 116, GID, 8)
  writeOct(buf, 124, size, 12)
  writeOct(buf, 136, FIXED_MTIME, 12)
  writeStr(buf, 148, '        ', 8) // 校验和位先留空
  writeStr(buf, 156, isDir ? '5' : '0', 1) // 类型：5=目录 0=普通文件
  // 157..256 = linkname（普通文件留空）
  //
  // ⚠️ magic 在 **257**，不是 157。写成 157 会落在 linkname 字段上，magic 保持全零；
  //    那时 npm 的 tar 解析器会退回 GNU tar 语义，把空的 linkname 当成
  //    "linkpath forbidden" 而拒绝整个包。系统 tar 与 Node 自己的解析器都不在意，
  //    所以这个错**只有 npm 会报** —— 必须在这里钉死正确的偏移。
  writeStr(buf, 257, 'ustar\0', 6) // magic
  writeStr(buf, 263, '00', 2) // version
  writeStr(buf, 265, UNAME, 32)
  writeStr(buf, 297, GNAME, 32)
  // 329..336 devmajor / 337..344 devminor（普通文件留空）
  writeStr(buf, 345, prefix, 155)

  writeChecksum(buf)
  return buf
}

/** 递归收集目录下的文件（不含目录条目 —— npm 包里的目录不需要单独条目） */
function collectFiles(rootDir) {
  const out = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.isFile()) out.push({ abs, rel: relative(rootDir, abs).split(sep).join('/') })
    }
  }
  walk(rootDir)
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/**
 * 把一个目录打成确定性 .tar.gz，内容放在 `package/` 前缀下（npm 约定）。
 *
 * @param {string} rootDir
 * @param {string} outPath
 * @returns {{entries: number, bytes: number}}
 */
export function targzDirectory(rootDir, outPath) {
  const files = collectFiles(rootDir)
  const blocks = []

  for (const f of files) {
    const data = readFileSync(f.abs)
    const name = `package/${f.rel}`
    blocks.push(tarHeader(name, data.length))
    blocks.push(data)
    // 数据补齐到 512 的整数倍
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }

  // 结束标记：两个全零块
  blocks.push(Buffer.alloc(1024))

  const tar = Buffer.concat(blocks)
  // 固定 gzip 参数，让字节稳定：level 9、OS 字节 255（未知）。
  //
  // ⚠️ MTIME 不能是 0：`mtime: 0` 会让 zlib 省略 MTIME 字段（FLG.FTEXT 之外的
  //    可选字段不写），而 npm 用的归档解析器**要求**该字段存在 —— 实测写成 0
  //    时 `npm install` 直接报 `TAR_BAD_ARCHIVE: Unrecognized archive format`，
  //    但系统 tar 和 Node 都能读。所以用一个**固定的非零**值。
  const gz = gzipSync(tar, { level: 9, mtime: FIXED_MTIME })
  // gzip 头的第 9 字节是 OS：zlib 会按平台写。统一改成 255。
  gz[9] = 255

  writeFileSync(outPath, gz)
  return { entries: files.length, bytes: gz.length }
}

// 允许直接跑：node _targz.mjs <目录> <输出.tgz>
if (process.argv[1] && process.argv[1].endsWith('_targz.mjs')) {
  const [, , dir, out] = process.argv
  if (!dir || !out) {
    console.error('用法: node scripts/_targz.mjs <目录> <输出.tgz>')
    process.exit(2)
  }
  const r = targzDirectory(dir, out)
  console.log(`已写出 ${out}：${r.entries} 个条目，${r.bytes} 字节`)
}
