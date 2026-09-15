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

/**
 * 判断一份 stdio 配置是否要用管道。
 *
 * ⚠️ 必须同时覆盖**三种**写法，否则注入器本身会漏：
 *     undefined            → 默认就是 pipe
 *     'pipe'               → 显式 pipe
 *     ['ignore','pipe',…]  → 数组形式，**最容易被漏掉的一种**
 *   实测踩过：早先这里只管前两种，于是 `stdio: ['ignore','pipe','ignore']` 被放行，
 *   注入器声称"已禁止管道"、实际没禁，导致依赖它的守卫检查给出假绿。
 */
function usesPipe(stdio) {
  if (stdio === undefined || stdio === 'pipe') return true
  if (Array.isArray(stdio)) return stdio.includes('pipe')
  return false
}

// execFileSync / execSync 家族：凡是要用管道的，一律抛 EPERM
const guarded = (fn) => function (file, args, opts) {
  if (usesPipe(opts && opts.stdio)) throw EPERM()
  return fn.apply(this, [file, args, opts])
}
cp.execFileSync = guarded(realExecFileSync)
cp.execSync = guarded(realExecSync)

// spawnSync：管道配置返回 EPERM（真实环境就是这个形状：status=null + error），
// 其余配置（'inherit' / 'ignore' / 重定向到 fd）放行。
cp.spawnSync = function (cmd, args, opts) {
  if (usesPipe(opts && opts.stdio)) {
    return { error: EPERM(), status: null, stdout: undefined, stderr: undefined }
  }
  return realSpawnSync.call(this, cmd, args, opts)
}

syncBuiltinESMExports()

console.log('### 已注入「禁止管道」故障（execFileSync / spawnSync 的 pipe 模式会抛 EPERM）###')
