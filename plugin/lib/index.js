/**
 * dsh-led-bridge —— 把 DeepSeek Harness 的工作状态推到 ESP32-C3 红绿灯
 * ============================================================================
 *
 * 工作原理
 * ---------------------------------------------------------------------------
 * 1. 插件跑在 DSH 进程内部（不是独立进程），订阅 `session/event` 拿到全量会话事件。
 * 2. 事件经状态机归约成 6 个人能看懂的状态：
 *      thinking / busy / error / alarm / success / off
 * 3. 状态变化时，通过 USB 串口往 ESP32-C3 写一行文本命令（换行结尾）。
 * 4. ESP32-C3 端的固件收到状态名后本地播放灯效（动画在板子上跑，
 *    所以串口上只有事件发生时才有一个短包，平时完全静默）。
 *
 * 线协议（极简，便于你以后自己扩展）
 * ---------------------------------------------------------------------------
 *   电脑 → 板子：  <state>\n        例如  thinking\n
 *   板子 → 电脑：  ESP32_STATUS_LIGHT READY   （上电后主动发一次，用于握手）
 *                  OK <state>                 （每次成功执行后回执）
 *
 * 串口自动发现
 * ---------------------------------------------------------------------------
 * 不写死 COM 号（换电脑 COM 号一定会变）。通过 USB 厂商号识别板子：
 *   Espressif 的 USB VID = 0x303A，原生 USB-Serial/JTAG 的 PID = 0x1001。
 * 找不到时每 5 秒重试一次；板子拔掉后会自动等待重新插入。
 *
 * @module dsh-led-bridge
 */

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

export const name = 'dsh-led-bridge'

/** 本插件不依赖任何其他服务，故声明为空（Cordis 允许）。 */
export const inject = []

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** Espressif Systems 的 USB 厂商号。 */
const ESPRESSIF_VID = '303a'
/** ESP32-C3 原生 USB-Serial/JTAG 的产品号。 */
const ESPRESSIF_USB_SERIAL_JTAG_PID = '1001'

/** 插件归约出的 6 个核心状态，也是发给板子的命令字。 */
const STATE = Object.freeze({
  OFF: 'off',
  THINKING: 'thinking',
  BUSY: 'busy',
  ERROR: 'error',
  ALARM: 'alarm',
  SUCCESS: 'success',
})

/**
 * 计划模式不是一个灯状态，而是「背景修饰」：
 * 它让绿灯常亮，同时不影响黄/红各自工作。
 * 因为灯板是三颗物理独立的灯珠，绿灯与黄/红同时亮是两个真实可见的颜色，不会混色。
 *
 * 发出的命令形如 `thinking+plan`、`plan`、`off`。
 */
const PLAN_SUFFIX = '+plan'

/**
 * 「有工具正在执行」上报为**独立命令**，不是状态名的修饰符。
 *
 * 架构原则（本插件只做归约，固件独占渲染）：
 *   - 插件报告的只有**事实**：当前前景状态、计划模式开关、有无工具在跑。
 *   - 「黄灯该呼吸还是绿灯该呼吸」「绿灯什么时候熄灭」这类**视觉与时序**决定
 *     全部归固件。所以插件里没有任何灯效时长参数。
 *
 * 具体这两个命令怎么渲染，见固件里的 updateToolsEffect()：
 *   `tools on`  → 工具在跑（绿灯以错开半周期的呼吸陪着黄灯）
 *   `tools off` → 不立即熄灭，由固件等走完一个完整呼吸周期再收尾
 *
 * 早期版本把「工具结束后的呼吸尾巴」做在插件里（一个 busyCooldownMs 定时器），
 * 那是架构越界：它会造出一个「必须依赖下一条命令才能结束」的中间态，
 * 插件一崩绿灯就卡在渐亮的尾巴上。已移到固件。
 */
const CMD_TOOLS_ON = 'tools on'
const CMD_TOOLS_OFF = 'tools off'

/** 板子固件支持的特殊命令：绿灯快闪两下（0.15s 亮 / 0.15s 灭 ×2）。 */
const CMD_NOTIFY = 'notify'

/** 默认配置。用户可在 profile 的 cordis.patch.yml 里按 id 覆盖。 */
const DEFAULTS = Object.freeze({
  /** 指定串口路径可跳过自动发现，例如 'COM3' 或 '/dev/ttyACM0'；空串 = 自动。 */
  port: '',
  /** 覆盖 USB 厂商号（16 进制小写，不带 0x）。 */
  vendorId: ESPRESSIF_VID,
  /** 覆盖 USB 产品号。 */
  productId: ESPRESSIF_USB_SERIAL_JTAG_PID,
  /** 串口波特率。原生 USB CDC 实际不受此值约束，填标准值即可。 */
  baudRate: 115200,
  /** 等申请授权的 alarm 是否超时回落。毫秒；0 = 永不回落。 */
  alarmTimeoutMs: 60000,
  /** 连不上板子时的重试间隔。毫秒。 */
  reconnectIntervalMs: 5000,
})

// ---------------------------------------------------------------------------
// 关于「空闲自动灭灯」为什么没有配置项
// ---------------------------------------------------------------------------
// 这里曾有 idleTimeoutMs（默认 300000），和固件里的 STALE_TIMEOUT_MS = 300000
// 是**同一件事的两份实现**。那是错的，两个原因：
//
// 1. **它是个骗人的旋钮。** 固件那份是无条件的，所以把它设成 0（本意"永不自动灭"）
//    或任何 ≥300000 的值都**不生效** —— 插件的定时器不发 off 了，固件照样在
//    5 分钟时把灯全灭。
//
// 2. **两者语义还不一样，于是会互相打架。**
//      插件：只在 #dispatch / #reportTools 时重新武装 → 测「多久没有新状态」
//      固件：在**每条被接受的命令**时重新武装      → 测「多久没有串口活动」
//    一次很长的推理（例如压缩上下文，thinking 持续几分钟，中间只有不发命令的
//    step/start 事件）会先触发插件那个定时器，把**正在工作**的灯灭掉；
//    而固件那边其实还"新鲜"。
//
// 所以只剩固件那一份。它更安全（长时间工作不会误灭），而且是**真的**兜底
// （电脑崩了、插件挂了，板子自己会灭灯）。代价是改超时要重烧固件 ——
// 但这个值极少改，远比"旋钮能用但会误灭"划算。
//
// 固件常量见 firmware/esp32c3_dsh_status_light/esp32c3_dsh_status_light.ino
// 的 STALE_TIMEOUT_MS。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 事件 → 状态 映射表
// ---------------------------------------------------------------------------

/**
 * DSH 会话事件 → 灯状态的映射。
 *
 * 事件名取自 @deepseek-ai/dsh-session 的 `known-event-types`（本机实测 56 种）。
 * 这里只挑与“人在外面看得懂的工作状态”相关的那部分；子智能体、压缩、
 * 多会话等按约定刻意忽略（见 Q6 决策：先只做 6 个核心状态）。
 */
const THINKING_EVENTS = new Set([
  'step/start',           // 一步开始
  'step/end',             // 一步结束，下一步仍在同一轮里
  'assistant/attempt',    // 真正发起了一次模型请求 —— “在想”
  'assistant/message',    // 模型回复落地
  'turn/start',           // 新一轮开始
])

/**
 * 【关键表】每个「开工」事件如何与它的「收工」事件配对。
 *
 * 为什么必须按 ID 精确配对，而不是简单加减计数 —— 这是真机踩出来的 bug：
 *   早期版本 #activeTools 只是个计数器：call 事件 +1、result 事件 −1。
 *   实测一个会话里 tool/result 比 tool/call 多 10 个，原因有两类：
 *     1. `command/done`、`hook/result` 被算作"收工"，但对应的
 *        `command/run` 与 `hook/invoked` 却没被算作"开工"；
 *     2. 一轮结束时最后一个 tool/call 有时拿不到配对的 tool/result。
 *   两者叠加使计数永远回不到 0，插件于是**永远不再发 `tools off`**，
 *   绿灯就一直呼吸不灭。用户真机看到的现象正是"跑完工具绿灯还在呼吸"。
 *
 * 正确做法：用事件自带的 ID 建集合，只有**配对得上**的收工事件才能移除。
 *   tool/call ↔ tool/result            主键 data.callId
 *                                          收工键 data.message.source.callId
 *   tool-workflow/run-start ↔ run-end  主键 data.runId
 *   tool-workflow/agent-start ↔ end    主键 `${data.runId}:${data.seq}`
 *   command/run ↔ command/done         主键 data.commandId
 *   compaction/start ↔ compaction/end  主键 data.compactionId
 *   hook/invoked ↔ hook/result         主键 data.hookId ?? data.id
 *
 * 字段名来自 @deepseek-ai/dsh-session 的 SessionEventMap 类型定义，不是猜的。
 */
const ID_PAIRS = [
  {
    start: 'tool/call',
    end: 'tool/result',
    key: (d) => d?.callId ?? d?.toolCallId ?? null,
    endKey: (d) => d?.message?.source?.callId ?? d?.message?.content?.[0]?.toolCallId ?? d?.callId ?? null,
  },
  {
    start: 'tool-workflow/run-start',
    end: 'tool-workflow/run-end',
    key: (d) => d?.runId ?? null,
    endKey: (d) => d?.runId ?? null,
  },
  {
    start: 'tool-workflow/agent-start',
    end: 'tool-workflow/agent-end',
    key: (d) => (d?.runId != null && d?.seq != null ? `${d.runId}:${d.seq}` : null),
    endKey: (d) => (d?.runId != null && d?.seq != null ? `${d.runId}:${d.seq}` : null),
  },
  {
    start: 'command/run',
    end: 'command/done',
    key: (d) => d?.commandId ?? null,
    endKey: (d) => d?.commandId ?? null,
  },
  {
    start: 'compaction/start',
    end: 'compaction/end',
    key: (d) => d?.compactionId ?? null,
    endKey: (d) => d?.compactionId ?? null,
  },
  {
    start: 'hook/invoked',
    end: 'hook/result',
    key: (d) => d?.hookId ?? d?.id ?? null,
    endKey: (d) => d?.hookId ?? d?.id ?? null,
  },
]

/** 事件类型 → 拓扑（是"开工"还是"收工"）。由 ID_PAIRS 反推，保证两边永远对称。 */
const EVENT_TOPOLOGY = new Map()
for (const pair of ID_PAIRS) {
  EVENT_TOPOLOGY.set(pair.start, { role: 'start', pair })
  EVENT_TOPOLOGY.set(pair.end, { role: 'end', pair })
}

/**
 * 这些"收工"事件同时也是**前景状态**的分界，必须走状态机自己的收尾逻辑
 * （清工具 + 切 succeed/error），不能只当成一次收工。
 * 见 handle() 里 SUCCESS_EVENTS 分支排在 RESULT_EVENTS 前面的注释。
 *
 * 目前是**空的**：所有配对事件的收工都只关掉活动记录，不当成前景状态变化。
 * 曾经在这里给 `command/done` 开过特例（想让它算"这一轮结束"），但那是
 * **擅自改动语义** —— 旧版本里 `command/done` 只关工具、前景纹丝不动。
 * 修 bug 就应该只修 bug，不要顺手改用户看得见的行为，故撤回。
 * 这个空集合保留着，是为了让"哪些收工事件例外"这件事有个显式的落点。
 */
const STATE_HANDLED_ENDS = new Set()

const SUCCESS_EVENTS = new Set([
  'turn/end',             // 一轮结束 —— “答完了”
])

const OFF_EVENTS = new Set([
  'session/end-seed',
])

/**
 * 「收工」事件集合 = 所有 ID_PAIRS 的 end 边，直接从拓扑推导，
 * 避免像早期版本那样手写两份集合、时间一长两边悄悄不一致。
 */
const RESULT_EVENTS = new Set(ID_PAIRS.map((p) => p.end))

const ERROR_EVENTS = new Set([
  'llm/retry',
  'llm/retry-started',
])

const ALARM_EVENTS = new Set([
  'approval/asked',       // 等你批准权限 —— 最需要你抬头看一眼的时刻
])

const ALARM_CLEAR_EVENTS = new Set([
  'approval/decided',
])

/**
 * 计划模式开关。载荷是 `{ active: boolean }`（见 dsh-plan-mode 的
 * `session.append('plan/mode', { active })`），属于「整体值」持续事件。
 */
const PLAN_MODE_EVENT = 'plan/mode'

/** 这两个只做「绿灯快闪两下」的通知，不改变当前状态。 */
const NOTIFY_ONLY_EVENTS = new Set([
  'goal/change',    // 目标状态变化
  'sandbox/mode',   // 沙箱模式变化
])

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * 从任意事件载荷里判断这次操作是不是失败。
 * 只做保守判断：只有明确看到错误标记才算失败。
 * @param {unknown} data - 事件载荷
 * @returns {boolean}
 */
function looksLikeFailure(data) {
  if (!data || typeof data !== 'object') return false
  // 明确的错误字段
  if (data.error || data.isError === true || data.failed === true) return true
  const status = data.status
  if (typeof status === 'string') {
    const s = status.toLowerCase()
    if (s === 'error' || s === 'failed' || s === 'failure') return true
  }
  // 判定 outcome / result 里的成功标记
  const outcome = data.outcome
  if (typeof outcome === 'string' && /error|fail/i.test(outcome)) return true
  return false
}

// ---------------------------------------------------------------------------
// 串口传输层
// ---------------------------------------------------------------------------

/**
 * 负责“发现板子 → 连接 → 写状态 → 掉线重连”的小传输层。
 * 它永不抛出：任何失败都只是记录日志并安排重试，不能影响 DSH 本体。
 */
class LedTransport extends EventEmitter {
  #port = null
  #connecting = false
  #disposed = false
  #retryTimer = null
  #pendingState = null
  #ready = false

  /**
   * @param {object} config - 已合并的配置
   * @param {(msg: string) => void} log - 日志函数
   */
  constructor(config, log) {
    super()
    this.config = config
    this.log = log
  }

  get isReady() {
    return this.#ready
  }

  /** 开始连接（幂等）。 */
  start() {
    if (this.#disposed) return
    void this.#attemptConnect()
  }

  /** 由外部状态机调用：把状态发给板子（连不上时暂存，连上后立刻补发）。 */
  send(state) {
    this.#pendingState = state
    this.#flush()
  }

  /** 释放所有资源。重复调用安全。 */
  dispose() {
    this.#disposed = true
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
    const port = this.#port
    this.#port = null
    this.#ready = false
    if (port && port.isOpen) {
      try {
        port.close(() => {})
      } catch {
        /* 关闭失败无所谓，进程退出会回收 */
      }
    }
  }

  // -- 内部 ----------------------------------------------------------------

  #scheduleRetry() {
    if (this.#disposed || this.#retryTimer !== null) return
    const delay = Math.max(1000, Number(this.config.reconnectIntervalMs) || DEFAULTS.reconnectIntervalMs)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#attemptConnect()
    }, delay)
    // 这个定时器不该拖住 Node 退出
    if (typeof this.#retryTimer.unref === 'function') this.#retryTimer.unref()
  }

  async #attemptConnect() {
    if (this.#disposed || this.#connecting || this.#port) return
    this.#connecting = true
    try {
      // ⚠️ serialport 的 ESM 命名空间布局很反直觉，这两样东西在【不同地方】：
      //     - SerialPort.list()      → 静态方法，挂在【类】上（mod.SerialPort.list）
      //     - ReadlineParser         → 命名空间的具名导出，【不在】类上
      //       （实测 mod.SerialPort.ReadlineParser === undefined）
      //    早期版本写成 `const SerialPort = await loadSerialPort()` 返回整个命名空间，
      //    于是 pickPortPath 里的 SerialPort.list() 实际调用的是 mod.list —— undefined，
      //    报 "SerialPort.list is not a function"，枚举永远失败、板子永远连不上。
      //    同时 `const { ReadlineParser } = SerialPort` 也会拿到 undefined。
      //    真机一跑就现形；离线自测因为用的是假 SerialPort 对象，完全测不出来。
      const sp = await loadSerialPort()
      if (!sp) {
        this.log('未安装 serialport 依赖，无法使用串口。请在插件目录执行 pnpm install。')
        return
      }
      const SerialPort = sp.SerialPort
      const ReadlineParser = sp.ReadlineParser
      if (typeof ReadlineParser !== 'function') {
        this.log('serialport 缺少 ReadlineParser，依赖可能已损坏。请在插件目录重装依赖。')
        return
      }

      const path = await pickPortPath(SerialPort, this.config, this.log)
      if (!path) {
        this.log('未发现 ESP32-C3（USB VID 303A）。请确认板子已插好 USB 线；每 5 秒重试。')
        return
      }

      const port = new SerialPort({ path, baudRate: Number(this.config.baudRate) || 115200, autoOpen: false })
      this.#port = port

      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))
      parser.on('data', (raw) => this.#onLine(String(raw)))
      port.on('error', (err) => this.log(`串口错误：${err && err.message ? err.message : err}`))
      port.on('close', () => this.#onClosed())

      await new Promise((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()))
      })

      this.#ready = true
      this.log(`已连接 ESP32-C3：${path}`)
      this.emit('connected', path)
      // 连上后把当前状态补发一次，保证两边一致
      this.#flush()
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      this.log(`连接失败：${msg}`)
      this.#teardownPort()
    } finally {
      this.#connecting = false
      if (!this.#port && !this.#disposed) this.#scheduleRetry()
    }
  }

  #teardownPort() {
    const port = this.#port
    this.#port = null
    this.#ready = false
    if (port && port.isOpen) {
      try {
        port.close(() => {})
      } catch {
        /* 忽略 */
      }
    }
  }

  #onClosed() {
    if (this.#port) {
      this.#ready = false
      this.#port = null
      this.log('板子已断开，等待重新插入…')
    }
    if (!this.#disposed) this.#scheduleRetry()
  }

  #onLine(line) {
    const text = line.trim()
    if (!text) return
    if (text.includes('READY')) {
      this.log(`板子握手成功：${text}`)
      this.#ready = true
      this.#flush()
      return
    }
    // 其余是板子的回执，只在调试时才有意义
    if (text.startsWith('ERR')) this.log(`板子回报：${text}`)
  }

  #flush() {
    const port = this.#port
    const state = this.#pendingState
    if (!port || !port.isOpen || state === null) return
    try {
      port.write(`${state}\n`, (err) => {
        if (err) this.log(`写入失败：${err.message}`)
      })
    } catch (err) {
      this.log(`写入异常：${err && err.message ? err.message : err}`)
    }
  }
}

/**
 * 动态加载 serialport。装不上/未安装时返回 null，而不是让插件加载失败。
 *
 * @returns {Promise<{SerialPort: any, ReadlineParser: any}|null>}
 *   注意这两样东西在 ESM 下**不在同一个对象上**（这是本插件踩过的坑）：
 *     - `SerialPort`     是命名空间的具名导出，`list()` 是它上面的静态方法
 *     - `ReadlineParser` 也是具名导出，但【没有】挂到类的静态属性上
 *   所以这里显式把两者都取出来，调用方不用再猜布局。
 */
async function loadSerialPort() {
  try {
    const mod = await import('serialport')
    const SerialPort = mod.SerialPort ?? mod.default?.SerialPort
    const ReadlineParser = mod.ReadlineParser ?? SerialPort?.ReadlineParser
    if (!SerialPort) return null
    return { SerialPort, ReadlineParser }
  } catch {
    return null
  }
}

/**
 * 选一个可用的串口路径：优先用户显式配置，其次按 USB VID/PID 自动发现。
 * @returns {Promise<string|null>}
 */
async function pickPortPath(SerialPort, config, log) {
  const explicit = typeof config.port === 'string' ? config.port.trim() : ''
  if (explicit) return explicit

  const wantVid = String(config.vendorId || ESPRESSIF_VID).toLowerCase()
  const wantPid = String(config.productId || ESPRESSIF_USB_SERIAL_JTAG_PID).toLowerCase()

  let ports = []
  try {
    ports = await SerialPort.list()
  } catch (err) {
    log(`枚举串口失败：${err && err.message ? err.message : err}`)
    return null
  }

  const match = ports.find((p) => {
    const vid = (p.vendorId || '').toLowerCase()
    const pid = (p.productId || '').toLowerCase()
    if (vid && pid) return vid === wantVid && pid === wantPid
    // 部分平台（尤其 macOS）拿不到 VID/PID，退回按设备名判断
    const path = String(p.path || '')
    return /usbmodem|usbserial|ttyACM|ttyUSB/i.test(path)
  })

  return match ? match.path : null
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * 把 DSH 事件流归约成灯状态，并在变化时驱动传输层。
 *
 * 内部维护两个正交的东西：
 *   1. `#base`  —— 前景状态：off / thinking / busy / error / alarm / success
 *   2. `#plan`  —— 计划模式开关（背景修饰，让绿灯常亮）
 * 实际下发给板子的命令 = base（若 plan 为真则追加 `+plan`）。
 *
 * 另外有两条「只闪一下不改变状态」的通知（goal/change、sandbox/mode），
 * 以及两个时序：计划模式退出闪两下、计划模式下答完一轮闪两下。
 */
class StateMachine {
  #base = null
  #plan = false
  #alarmTimer = null
  #stateBeforeAlarm = STATE.THINKING

  /**
   * 每类「开工」事件当前还开着的主键集合。
   * Map<pair, Set<id>>，pair 就是 ID_PAIRS 里的那个对象。
   *
   * 用集合而不是计数器，是本插件最重要的一个修正：
   * 只有**配对得上**的收工事件才能移除，收工事件多出来也不会把计数带回 0 以下、
   * 更不会出现"计数永远回不到 0 → 绿灯永远不灭"。
   */
  #active = new Map()
  /** 收到过主键、但没能和开工事件配上的收工事件数（用于日志排查）。 */
  #unmatchedEnds = 0
  /**
   * 是否已经向板子报过 `tools on`。
   * 单独记这个是为了**去重**：一轮里几十次工具调用不该产生几十条串口命令。
   */
  #toolsOn = false

  /**
   * @param {object} config
   * @param {LedTransport} transport
   * @param {(msg: string) => void} log
   */
  constructor(config, transport, log) {
    this.config = config
    this.transport = transport
    this.log = log
  }

  /** 当前下发给板子的状态命令（含 +plan 修饰）。 */
  get current() {
    if (this.#base === null) return null
    // base 为 off 时不需要修饰：`plan` 命令本身就等于「全灭 + 绿灯常亮」
    if (this.#base === STATE.OFF) return this.#plan ? 'plan' : STATE.OFF
    return this.#plan ? `${this.#base}${PLAN_SUFFIX}` : this.#base
  }

  /** 工具状态是否已上报为「在跑」（仅供日志与自测使用）。 */
  get toolsReported() {
    return this.#toolsOn
  }

  /** 当前还有几类活动开着（所有 pair 的集合大小之和）；仅供日志与自测使用。 */
  get activeCount() {
    let n = 0
    for (const set of this.#active.values()) n += set.size
    return n
  }

  /** 有主键却没配上的收工事件数；仅供日志与自测使用。 */
  get unmatchedEnds() {
    return this.#unmatchedEnds
  }

  #dispatch() {
    const cmd = this.current
    if (cmd === null) return
    this.transport.send(cmd)
    this.log(`状态 → ${cmd}`)
  }

  /** 强制下发一次当前命令，绕过去重（用于「状态没变但修饰变了」的情况）。 */
  #forceDispatch() {
    this.#dispatch()
  }

  /** 主动设置前景状态（去重后下发）。 */
  set(state) {
    if (this.#base === state) return
    this.#base = state
    this.#dispatch()
  }

  /**
   * 一次「开工」事件：把主键放进对应集合，并上报工具状态。
   *
   * 插件只回答两个问题：
   *   1. 前景是不是 thinking？（是就切过去，因为工具是在模型思考期间被调用的）
   *   2. 有没有活儿在跑？（有就报 `tools on`，带去重）
   *
   * **插件不关心**黄灯该不该呼吸、绿灯该什么时候熄灭 —— 那是固件的事。
   * 早期版本在这里做了「工具结束后的呼吸尾巴」（一个定时器 + busyCooldownMs），
   * 那是架构越界，已整体移到固件。
   */
  #trackStart(pair, id) {
    if (id === null) return
    let set = this.#active.get(pair)
    if (set === undefined) {
      set = new Set()
      this.#active.set(pair, set)
    }
    set.add(id)
    // 前景切到 thinking：工具是模型思考期间调的。若已经是 thinking 则 set() 会去重。
    this.set(STATE.THINKING)
    this.#reportTools()
  }

  /**
   * 一次「收工」事件：只有主键**配对得上**才移除。
   *
   * 关键是「配不上就完全不动计数」。这样 `tool/result` 比 `tool/call` 多出来的
   * 那些（实测一个会话多 10 个）不会把状态带偏，绿灯也不会永远不灭。
   *
   * 上报同样是「立即」，不带任何延迟：绿灯的呼吸尾巴由固件负责走完，
   * 插件即使立刻退出，板子也能自己把灯收干净。
   */
  #trackEnd(pair, id) {
    const set = this.#active.get(pair)
    if (id === null || set === undefined || !set.has(id)) {
      // 配不上的收工事件：忽略，绝不动计数
      this.#unmatchedEnds++
      return
    }
    set.delete(id)
    if (set.size > 0) return   // 这类里还有别的在跑
    this.#active.delete(pair)
    this.#reportTools()
  }

  /** 按当前活动集合上报工具开关。带去重，重复调用不产生串口流量。 */
  #reportTools() {
    const shouldBeOn = this.activeCount > 0
    if (shouldBeOn === this.#toolsOn) return
    this.#toolsOn = shouldBeOn
    this.transport.send(shouldBeOn ? CMD_TOOLS_ON : CMD_TOOLS_OFF)
    this.log(`工具状态 → ${shouldBeOn ? '在跑' : '结束'}`)
  }

  /**
   * 清掉所有活动记录并上报 off（用于 alarm / error / 收尾等"这段作废"的场景）。
   *
   * 这是**唯一**能在主键配不上的情况下强行归零的入口：当 DSH 明确宣告
   * 「这一轮/这次会话结束了」，残留的未闭合 call 就不再有意义了。
   * 真机上正是这一条兜住了"最后一个 tool/call 没等到 tool/result"的情况。
   * 不带延迟，理由同 #trackEnd。
   */
  #resetTools() {
    this.#active.clear()
    this.#reportTools()
  }

  /**
   * 让板子绿灯快闪两下（0.15s 亮 / 0.15s 灭 ×2）。
   *
   * 用 `notify <after>` 形式：固件在闪烁期间会强制「只亮绿灯」并独占控制权，
   * 所以即使背景本来就是常亮绿灯，这两下闪烁依然清晰可见；闪完自动切到 after。
   *
   * @param {{foreground: string, plan: boolean}|null} after
   *   闪完后要切到的状态；null = 回到闪烁前的状态。
   *   传对象而不是字符串，是因为调用方往往需要**在改动自身状态之前**
   *   先把"目标状态"固化下来（见计划模式退出分支）。
   */
  #notify(after = null) {
    if (after === null) {
      this.transport.send(CMD_NOTIFY)
    } else {
      const cmd = after.plan ? `${after.foreground}${PLAN_SUFFIX}` : after.foreground
      this.transport.send(`${CMD_NOTIFY} ${cmd}`)
    }
  }

  /** 处理一个 DSH 会话事件。永不抛出。 */
  handle(event) {
    try {
      if (!event || typeof event !== 'object') return
      const type = event.type
      const data = event.data
      if (typeof type !== 'string') return

      // ---- 计划模式开关（背景修饰，不抢占前景） ----
      if (type === PLAN_MODE_EVENT) {
        const active = !!(data && data.active === true)
        if (active === this.#plan) return
        this.#clearAlarmTimer()
        if (active) {
          this.#plan = true
          // 进入计划模式：绿灯开始常亮，前景状态不变
          this.#base = this.#base === null ? STATE.OFF : this.#base
          this.#dispatch()
        } else {
          // 退出计划模式：绿灯快闪两下，然后回到**前景**状态。
          //
          // 两个刻意的决定：
          //  1. 目标状态**不带 +plan** —— 计划模式已经关了，绿灯该恢复正常，
          //     不能继续常亮（否则"退出计划模式"这个动作看不出来）。
          //  2. 必须在改 #plan **之前**把目标算出来。早期版本先写 #plan = false，
          //     于是 current 从 "error+plan" 变成了 "error"，虽然恰好也对，
          //     但那是巧合；顺序写反了就会丢掉前景信息。
          //     `#notify({foreground, plan:false})` 显式表达"我不保留 plan"。
          const after = { foreground: this.#base === null ? STATE.OFF : this.#base, plan: false }
          this.#plan = false
          this.#notify(after)
          this.log(`计划模式关闭 → 绿灯闪两下 → ${this.current}`)
        }
        return
      }

      // ---- 只闪一下、不改变状态的通知 ----
      if (NOTIFY_ONLY_EVENTS.has(type)) {
        this.#notify(null)
        this.log(`${type} → 绿灯闪两下（状态不变：${this.current ?? STATE.OFF}）`)
        return
      }

      // ---- 轮次边界：无条件对账，丢掉跨轮残留的未闭合记录 ----
      //
      // 为什么必须有这一条：实测最后一个 tool/call 有时永远等不到配对的
      // tool/result，那条记录会一直挂在集合里，于是 `tools off` 永远不发、
      // 绿灯永远不灭。DSH 明确宣告"这一轮开始了/结束了"时，上一轮的残留
      // 就已经没有意义，在这里一刀清干净。
      //
      // 放在 alarm 优先级判断**之后**、其它分支之前：alarm 期间不该被轮次边界打断。
      if (type === 'turn/start' || type === 'turn/end') {
        this.#resetTools()
      }

      // ---- 计划模式下「答完一轮」：闪两下再保持绿灯常亮（而不是静默不变） ----
      if (SUCCESS_EVENTS.has(type) && this.#plan) {
        this.#base = STATE.SUCCESS
        this.#notify({ foreground: STATE.SUCCESS, plan: this.#plan })
        this.log(`计划模式下答完一轮 → 绿灯闪两下 → 保持绿灯常亮`)
        return
      }

      // ---- alarm 最高优先级：一旦在等用户，其他事件不夺权 ----
      if (ALARM_EVENTS.has(type)) {
        this.#stateBeforeAlarm = this.#base === STATE.ALARM ? this.#stateBeforeAlarm : (this.#base || STATE.THINKING)
        this.#clearAlarmTimer()
        // 等用户期间工具计数与尾窗都无意义了，清掉避免之后误判
        this.#resetTools()
        this.set(STATE.ALARM)
        this.#armAlarmTimer()
        return
      }
      if (ALARM_CLEAR_EVENTS.has(type)) {
        this.#clearAlarmTimer()
        this.set(STATE.THINKING)
        return
      }
      if (this.#base === STATE.ALARM) {
        // alarm 期间其余事件不夺权，等 timeout 或 decided
        return
      }

      if (RESULT_EVENTS.has(type)) {
        const topo = EVENT_TOPOLOGY.get(type)
        if (topo !== undefined && !STATE_HANDLED_ENDS.has(type)) {
          // 配对事件的收工**只关掉活动记录**，不当成前景状态变化：
          // 压缩结束、命令行结束都不代表"答完了"。行为与修复前完全一致，
          // 改的只是"怎么数"（按 ID 配对而不是盲计数）。
          if (looksLikeFailure(data)) {
            this.#resetTools()
            this.set(STATE.ERROR)
          } else {
            this.#trackEnd(topo.pair, topo.pair.endKey(data))
          }
          return
        }
      }

      if (ERROR_EVENTS.has(type)) {
        this.#resetTools()
        this.set(STATE.ERROR)
        return
      }
      if (EVENT_TOPOLOGY.has(type)) {
        // 工具开始执行。前景切到 thinking、并上报 tools on —— 两件事都在
        // #trackStart() 里做（它内部调 set()，会去重）。
        const topo = EVENT_TOPOLOGY.get(type)
        this.#trackStart(topo.pair, topo.pair.key(data))
        return
      }
      if (THINKING_EVENTS.has(type)) {
        // ⚠️ 关键：这里【绝不能】碰工具状态。
        //    一轮里的事件流是 tool/result → assistant/message(thinking) → tool/call …
        //    每个 thinking 事件都紧跟在工具结果之后。早期版本在这里清掉工具状态，
        //    绿灯刚亮就被熄灭，真机观测到的现象就是"绿灯闪半秒又回黄灯"。
        //    现在 thinking 只保证前景是 thinking（黄灯呼吸），是否上报 tools off
        //    完全由活动记录决定（见 #trackEnd）。
        this.set(STATE.THINKING)
        return
      }
      if (SUCCESS_EVENTS.has(type)) {
        this.#resetTools()
        this.set(STATE.SUCCESS)
        return
      }
      if (OFF_EVENTS.has(type)) {
        // 顺序很关键：工具上报、计划模式都必须在设置 #base 之前处理完，
        // 否则去重逻辑会把下发整个吞掉，板子会一直停在上一个状态
        // （这是个真实踩过的 bug，有回归测试守着）。
        this.#resetTools()          // 先上报 tools off（若有工具在跑）
        const hadPlan = this.#plan
        this.#plan = false
        this.#base = STATE.OFF
        this.#forceDispatch()
        if (hadPlan) this.log('会话结束 → 同时清掉计划模式')
        return
      }
      // 其余事件按约定忽略
    } catch (err) {
      this.log(`事件处理异常（已忽略）：${err && err.message ? err.message : err}`)
    }
  }

  dispose() {
    this.#clearAlarmTimer()
    this.#resetTools()
  }

  // -- 内部 ----------------------------------------------------------------

  #armAlarmTimer() {
    const ms = Number(this.config.alarmTimeoutMs)
    if (!ms || ms <= 0) return
    this.#alarmTimer = setTimeout(() => {
      this.#alarmTimer = null
      this.set(this.#stateBeforeAlarm || STATE.THINKING)
    }, ms)
    if (typeof this.#alarmTimer.unref === 'function') this.#alarmTimer.unref()
  }

  #clearAlarmTimer() {
    if (this.#alarmTimer !== null) {
      clearTimeout(this.#alarmTimer)
      this.#alarmTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * 供离线自测使用的导出（`scripts/selftest.mjs` 会 import 这些）。
 * 正常运行时 DSH 只使用下面的 apply()。
 */
export const __testing = Object.freeze({
  EVENT_SETS: {
    THINKING: THINKING_EVENTS,
    // BUSY 已由「开工/收工 ID 配对表」取代，保留这个名字指向所有"开工"事件，
    // 方便自测按老习惯遍历。
    BUSY: new Set(ID_PAIRS.map((p) => p.start)),
    SUCCESS: SUCCESS_EVENTS,
    OFF: OFF_EVENTS,
    RESULT: RESULT_EVENTS,
    ERROR: ERROR_EVENTS,
    ALARM: ALARM_EVENTS,
    ALARM_CLEAR: ALARM_CLEAR_EVENTS,
    NOTIFY_ONLY: NOTIFY_ONLY_EVENTS,
  },
  STATE,
  DEFAULTS,
  PLAN_MODE_EVENT,
  PLAN_SUFFIX,
  CMD_NOTIFY,
  ID_PAIRS,
  EVENT_TOPOLOGY,
  STATE_HANDLED_ENDS,
  looksLikeFailure,
  pickPortPath,
  StateMachine,
})

/**
 * Cordis 插件入口。
 * @param {any} ctx - 插件上下文
 * @param {object} [config] - 来自 profile patch 的配置
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[dsh-led-bridge] ${msg}`)
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  const transport = new LedTransport(cfg, log)
  const machine = new StateMachine(cfg, transport, log)

  // 订阅全量会话事件（这是 DSH 原生能力，拿得到 56 种事件）
  ctx.on('session/event', (_session, event) => machine.handle(event))

  // 板子插上后，把当前状态补发一次
  transport.on('connected', () => {
    // 刚连上时若还没有任何状态，先给一个全灭，避免灯停在随机状态
    transport.send(machine.current || STATE.OFF)
  })

  transport.start()
  log('已启动，等待 ESP32-C3 插入…')

  // Cordis 的 effect 清理
  return () => {
    machine.dispose()
    transport.dispose()
  }
}
