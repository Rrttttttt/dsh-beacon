/**
 * 多帧 zstd 会话日志解码器
 * ============================================================================
 * DSH 的会话日志是「每行一个独立 zstd 帧」的拼接文件。
 * zstdDecompressSync 只解第一帧，所以需要按 magic 切分后逐帧解压。
 *
 * 用法：node scripts/zstd-frames.mjs <file.jsonl.zstd> [输出到文件]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decodeMultiFrameZstd(buf) {
  const starts = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) {
    starts.push(i)
    i += 4
  }
  if (!starts.length) throw new Error('没有找到 zstd 帧')

  const out = []
  let ok = 0
  let bad = 0
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k]
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      out.push(zstdDecompressSync(buf.subarray(from, to)).toString('utf8'))
      ok++
    } catch {
      bad++
    }
  }
  return { text: out.join(''), ok, bad, frames: starts.length }
}

// 作为脚本直接运行时
if (process.argv[1] && process.argv[1].endsWith('zstd-frames.mjs')) {
  const src = process.argv[2]
  if (!src) {
    console.log('用法: node scripts/zstd-frames.mjs <file.jsonl.zstd> [out.txt]')
    process.exit(1)
  }
  const r = decodeMultiFrameZstd(readFileSync(src))
  console.log(`帧: ${r.frames}  成功: ${r.ok}  失败: ${r.bad}`)
  console.log(`解压文本: ${(r.text.length / 1024 / 1024).toFixed(2)} MB`)
  if (process.argv[3]) {
    writeFileSync(process.argv[3], r.text)
    console.log(`已写到 ${process.argv[3]}`)
  }
}
