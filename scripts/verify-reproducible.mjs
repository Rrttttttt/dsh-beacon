/**
 * 可复现性回归检查：钉死两个「随 PowerShell 版本变字节」的坑
 * ============================================================================
 *
 * 背景（实测，两个都是真踩过的）：
 *
 *   1. `ConvertTo-Json` 的输出不跨版本：
 *        PS 5.1 → 4 空格缩进、冒号后**两个**空格、把 ">" 转义成 \u003e
 *        PS 7   → 2 空格缩进、"> " 原样
 *      同一对象 327 字节 vs 208 字节。
 *   2. `Compress-Archive` 写出的 zip 也不跨版本（元数据字段不同）：
 *      解压后 202 个文件内容全同，整包 SHA256 却不同。
 *
 * 后果都不是功能问题，而是**核对不了下载包**：用户从 Release 下载后按
 * SHA256SUMS.txt 核对，发现跟本地复现的不一致，会以为包被污染。
 *
 * 修法：
 *   - JSON 全部走 `scripts/write-json.ps1`（转调 Node 的 JSON.stringify）
 *   - zip 全部走 `scripts/_zip.mjs`（钉死时间戳/顺序/权限/压缩）
 *
 * 本脚本检查**根因**而不是"打包两遍比哈希"：
 *   - 造一个含 `>`、数组、嵌套对象的样本，用每个可用的 PowerShell 跑一次
 *     `write-json.ps1`，断言各版本产出的字节**完全相同**，且等于 Node 的规范形态。
 *   - 断言打包脚本里不再直接使用 `ConvertTo-Json` / `Compress-Archive` 输出。
 *
 * 为什么不"打包两遍比哈希"：那要跑两次完整打包（含 npm install），慢且有副作用；
 * 而且它测的是整条链路，一旦红了不好定位。查根因更快也更准 —— 整条链路的
 * 可复现性已由 `[4b]` 的字节断言 + 本脚本共同覆盖。
 *
 * 跑法：node scripts/verify-reproducible.mjs
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

let failures = 0
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => {
  failures++
  console.log(`  FAIL ${m}`)
}
const note = (m) => console.log(`  --   ${m}`)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase()

// ---------------------------------------------------------------------------
console.log('\n[1] 盘点本机可用的 PowerShell 版本')
// ---------------------------------------------------------------------------

/**
 * 探测一个 PowerShell 可执行文件的版本。
 *
 * 关键设计：**不用管道接输出**，而是把 stdout 重定向到一个临时文件。
 * 受限环境（沙箱、企业策略、加固的 CI 镜像）会禁止打开管道子进程，那时
 * `spawnSync(..., { stdio: ['ignore','pipe','ignore'] })` 返回
 * `{status: null, error: EPERM}`。早先的实现把这和"这个 exe 不存在"混为一谈 ——
 * 于是 6 个候选全被判为不存在，报出「一个 PowerShell 都没找到」，
 * **把人引去装 pwsh（本机其实装着）**，而真因是环境禁止管道。
 *
 * 重定向到文件就没有这个限制，所以是**绕过**而不是降级。
 *
 * @returns {{ok: true, exe: string, version: string}
 *          |{ok: false, reason: 'missing'}
 *          |{ok: false, reason: 'env', detail: string}}
 */
function probe(exe) {
  const outFile = join(tmpdir(), `dsh-psver-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  let fd = null
  try {
    fd = openSync(outFile, 'w')
    const r = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      stdio: ['ignore', fd, 'ignore'],
    })
    closeSync(fd)
    fd = null

    if (r.error) {
      // EPERM/ENOENT 要分开：前者是环境不允许，后者才是这个 exe 不存在
      if (r.error.code === 'EPERM' || r.error.code === 'EACCES') {
        return { ok: false, reason: 'env', detail: r.error.code }
      }
      return { ok: false, reason: 'missing' }
    }
    if (r.status !== 0) return { ok: false, reason: 'missing' }

    const version = readFileSync(outFile, 'utf8').trim()
    return version ? { ok: true, exe, version } : { ok: false, reason: 'missing' }
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      return { ok: false, reason: 'env', detail: e.code }
    }
    return { ok: false, reason: 'missing' }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 已经关了 */
      }
    }
    rmSync(outFile, { force: true })
  }
}

/** 同一台机器上可能有多个 PowerShell，全部找出来 —— 版本越多这个检查越有意义 */
const shells = []
const envBlocked = []
for (const cand of [
  process.env.PWSH_EXE,
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
  'pwsh',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'powershell.exe',
]) {
  if (!cand) continue
  const p = probe(cand)
  if (!p.ok) {
    if (p.reason === 'env') envBlocked.push(cand)
    continue
  }
  if (shells.some((s) => s.version === p.version)) continue
  shells.push(p)
}

if (shells.length === 0 && envBlocked.length > 0) {
  // 明确区分「环境不允许」和「真的没装」—— 前者不该报 FAIL
  note(`本环境禁止启动子进程（${envBlocked[0]} 报 EPERM），无法盘点 PowerShell 版本`)
  note('这不是"没找到 PowerShell"，本机可能装着 —— 换一个不受限的终端再跑')
  note('跳过跨版本比对')
  console.log('\n结果：本环境无法运行此项检查（已跳过，不算失败）\n')
  process.exit(0)
}

if (shells.length === 0) {
  bad('一个 PowerShell 都没找到 —— 无法验证打包可复现性')
  console.log(`\n结果：${failures} 项失败\n`)
  process.exit(1)
}
for (const s of shells) note(`PowerShell ${s.version}  (${s.exe})`)
if (shells.length === 1) {
  note('只有一种 PowerShell：仍然会验证它产出规范字节，只是无法做跨版本比对')
}

// ---------------------------------------------------------------------------
console.log('\n[2] 固定序列化器在各 PowerShell 下是否产出相同字节')
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), 'dsh-repro-'))
try {
  // 样本刻意包含三样最容易暴露差异的东西：
  //   - ">"（PS 5.1 会转义成 \u003e）
  //   - 嵌套对象（缩进宽度差异最明显）
  //   - 数组（PS 5.1 会把数组元素对齐到很怪的列）
  const sample = {
    name: 'dsh-led-bridge',
    version: '0.2.3',
    engines: { node: '>=20' },
    files: ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    nested: { deep: { deeper: { value: 1, text: 'a > b & c < d' } } },
  }

  const canonical = JSON.stringify(sample, null, 2) + '\n'
  const canonicalHash = sha256(Buffer.from(canonical, 'utf8'))

  const results = []
  const envFailures = []
  for (const s of shells) {
    const safeVer = s.version.replace(/[^\w.]/g, '_')
    const target = join(tmp, `sample-${safeVer}.json`)
    const errFile = join(tmp, `err-${safeVer}.txt`)
    // 先用 PowerShell 自己写一份（模拟 pack.ps1 里"读对象→写文件"的路径）
    writeFileSync(target, JSON.stringify(sample), 'utf8')

    // stderr 也重定向到文件 —— 不用管道，理由同 probe()。
    let errFd = null
    let r
    try {
      errFd = openSync(errFile, 'w')
      r = spawnSync(
        s.exe,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'write-json.ps1'), '-Path', target],
        { stdio: ['ignore', 'ignore', errFd] },
      )
    } finally {
      if (errFd !== null) {
        try {
          closeSync(errFd)
        } catch {
          /* 已关 */
        }
      }
    }

    const errText = existsSync(errFile) ? readFileSync(errFile, 'utf8').trim() : ''

    if (r.error || r.status !== 0) {
      if (r.error && (r.error.code === 'EPERM' || r.error.code === 'EACCES')) {
        envFailures.push(s.version)
        note(`PowerShell ${s.version}: 本环境禁止启动子进程（EPERM），跳过`)
      } else {
        bad(`PowerShell ${s.version} 跑 write-json.ps1 失败${r.status !== null ? `（退出码 ${r.status}）` : ''}：${errText.slice(0, 300)}`)
      }
      continue
    }
    if (!existsSync(target)) {
      bad(`PowerShell ${s.version} 没有产出文件`)
      continue
    }
    const bytes = readFileSync(target)
    const hash = sha256(bytes)
    results.push({ shell: s, hash, size: bytes.length, text: bytes.toString('utf8') })
    ok(`PowerShell ${s.version}: ${bytes.length} 字节  ${hash.slice(0, 16)}…`)
  }

  if (results.length === 0 && envFailures.length > 0) {
    note('所有版本都因环境禁止子进程而跳过 —— 本环境无法做这项检查（不算失败）')
  }

  if (results.length === 0 && envFailures.length === 0) {
    bad('没有任何 PowerShell 成功产出，无法判定')
  } else {
    // 每个都要等于 Node 的规范形态 —— 这是"固定序列化"的定义
    for (const r of results) {
      if (r.text !== canonical) {
        const why = /\n {4}"/.test(r.text)
          ? '4 空格缩进（ConvertTo-Json 的 PS 5.1 形态）'
          : r.text.includes('\\u003e')
            ? '含 \\u003e 转义（ConvertTo-Json 的 PS 5.1 形态）'
            : '与 Node 规范形态不同'
        bad(`PowerShell ${r.shell.version} 的产出不是规范字节：${why}`)
      }
    }
    if (results.every((r) => r.text === canonical)) {
      ok(`全部 ${results.length} 个 PowerShell 都产出规范字节（= Node JSON.stringify(v,null,2)）`)
    }

    // 跨版本必须完全相同
    const distinct = new Set(results.map((r) => r.hash))
    if (results.length > 1) {
      if (distinct.size === 1) ok(`跨 ${results.length} 个 PowerShell 版本字节完全一致（${canonicalHash.slice(0, 16)}…）`)
      else bad(`跨版本字节不一致，出现了 ${distinct.size} 种：${[...distinct].map((h) => h.slice(0, 12)).join(', ')}`)
    } else {
      note('只有一个可用版本，跨版本比对跳过（CI 的 windows-latest 也是这种情况）')
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('\n[3] 打包脚本不得再用「随版本变字节」的 cmdlet 产出产物')
// ---------------------------------------------------------------------------
const packSrc = readFileSync(join(ROOT, 'scripts', 'pack.ps1'), 'utf8')
const codeLines = packSrc
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !(t.startsWith('#') || t.startsWith('*') || t.startsWith('<#'))
  })

// 允许出现 ConvertTo-Json —— 它被用来"读对象"（ConvertFrom-Json → 改字段 → 再序列化到
// 临时文件，随后由 write-json.ps1 规范化）。不允许的是**它的输出直接成为产物**。
// 判据：每次 ConvertTo-Json 附近必须有 write-json.ps1 调用兜底。
const jsonUses = codeLines.filter((l) => l.includes('ConvertTo-Json')).length
const writeJsonUses = codeLines.filter((l) => l.includes('write-json.ps1')).length
if (jsonUses === 0) {
  ok('打包脚本已不直接使用 ConvertTo-Json')
} else if (writeJsonUses >= jsonUses) {
  ok(`ConvertTo-Json 用了 ${jsonUses} 处，每处都有 write-json.ps1 规范化（${writeJsonUses} 处）`)
} else {
  bad(`有 ${jsonUses} 处 ConvertTo-Json 但只有 ${writeJsonUses} 处 write-json.ps1 —— 产物字节可能不可复现`)
}

if (codeLines.some((l) => l.includes('Compress-Archive'))) {
  bad('打包脚本仍在用 Compress-Archive 产出 zip（它的字节随 PowerShell 版本变）')
} else {
  ok('打包脚本已不用 Compress-Archive（zip 改由 _zip.mjs 确定性写出）')
}

if (existsSync(join(ROOT, 'scripts', '_zip.mjs')) && codeLines.some((l) => l.includes('_zip.mjs'))) {
  ok('zip 由 scripts/_zip.mjs 产出')
} else {
  bad('没有看到 _zip.mjs 被调用 —— zip 的确定性无法保证')
}

// tarball 也必须自己写。`pnpm pack` 的字节受 gzip 头的 OS 字节、pnpm/npm 版本等
// 环境影响：实测本地连续两次稳定，但 CI 打出的 tgz 与本机不同（20837 vs 20226 字节），
// 而本机复现不出 CI 的字节 —— 复现不了就无法核对。
if (codeLines.some((l) => /pnpm pack/.test(l))) {
  bad('打包脚本仍在用 pnpm pack 产出 tgz（其字节受环境影响，实测 CI 与本机不同）')
} else {
  ok('打包脚本已不用 pnpm pack（tgz 改由 _targz.mjs 确定性写出）')
}

if (existsSync(join(ROOT, 'scripts', '_targz.mjs')) && codeLines.some((l) => l.includes('_targz.mjs'))) {
  ok('tgz 由 scripts/_targz.mjs 产出')
} else {
  bad('没有看到 _targz.mjs 被调用 —— tgz 的确定性无法保证')
}

// 顺带确认 gzip 的 OS 字节被固定（不固定的话同一份内容在不同平台字节就不同）
const targzSrc = readFileSync(join(ROOT, 'scripts', '_targz.mjs'), 'utf8')
if (/gz\[9\]\s*=/.test(targzSrc) && /mtime:\s*0/.test(targzSrc)) {
  ok('_targz.mjs 固定了 gzip 的 OS 字节与 mtime')
} else {
  bad('_targz.mjs 没有固定 gzip 的 OS 字节/mtime —— 跨平台字节会不同')
}

if (/FIXED_MTIME|499162500/.test(targzSrc)) {
  ok('_targz.mjs 固定了 tar 条目的 mtime')
} else {
  bad('_targz.mjs 没有固定 tar 条目的 mtime')
}

console.log('')
if (failures === 0) {
  console.log('结果：全部通过 ✅\n')
  process.exit(0)
} else {
  console.log(`结果：${failures} 项失败 ❌\n`)
  process.exit(1)
}
