/**
 * 故障注入 loader：模拟"环境禁止管道子进程"
 * ============================================================================
 *
 * 用途：验证 `verify-all.mjs` 的降级路径真的有效。
 *
 * 我自己的开发环境**允许**管道，所以那条 EPERM 降级分支从来没被跑到过。
 * 没被跑过的容错代码 = 没写。这个 loader 把 `execFileSync` / `spawnSync(stdio:'pipe')`
 * 强制改成抛 EPERM，从而在本地复现受限环境。
 *
 * 用法：
 *   node --import ./scripts/_inject-nopipe.mjs scripts/verify-all.mjs
 *
 * 期望：不再出现假 FAIL；B/C 两项要么正常通过（走 inherit 降级），
 *       要么被明确标成"本环境无法运行"，而不是"检查失败"。
 */

import { syncBuiltinESMExports } from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')

const EPERM = () => {
  const err = new Error('spawnSync EPERM (simulated: pipes disabled)')
  err.code = 'EPERM'
  err.errno = -4048
  err.syscall = 'spawnSync'
  // 关键：真实 EPERM 下 stdout/stderr 是 undefined，
  // 这正是 verify-all 用来区分"环境不允许"和"子脚本失败"的依据。
  return err
}

const realSpawnSync = cp.spawnSync
const realExecFileSync = cp.execFileSync
const realExecSync = cp.execSync

// execFileSync / execSync 家族：若未显式指定 stdio（即默认管道），抛 EPERM
const guarded = (fn) => function (file, args, opts) {
  const stdio = opts && opts.stdio
  const usesPipe = stdio === undefined || stdio === 'pipe' || (Array.isArray(stdio) && stdio[1] === 'pipe')
  if (usesPipe) throw EPERM()
  return fn.apply(this, [file, args, opts])
}
cp.execFileSync = guarded(realExecFileSync)
cp.execSync = guarded(realExecSync)

// spawnSync：stdio 为 'inherit'/'ignore' 时放行，管道时抛 EPERM
cp.spawnSync = function (cmd, args, opts) {
  const stdio = opts && opts.stdio
  const usesPipe = stdio === undefined || stdio === 'pipe'
  if (usesPipe) return { error: EPERM(), status: null, stdout: undefined, stderr: undefined }
  return realSpawnSync.call(this, cmd, args, opts)
}

syncBuiltinESMExports()

console.log('### 已注入「禁止管道」故障（execFileSync / spawnSync 的 pipe 模式会抛 EPERM）###')
