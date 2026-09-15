import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

export const name = 'dsh-led-bridge'

export const inject = []

const VENDOR_ID = '303a'

const PRODUCT_ID = '1001'

const STATE = Object.freeze({
  OFF: 'off',
  THINKING: 'thinking',
  BUSY: 'busy',
  ERROR: 'error',
  ALARM: 'alarm',
  SUCCESS: 'success',
})

const PLAN_SUFFIX = '+plan'

const CMD_TOOLS_ON = 'tools on'
const CMD_TOOLS_OFF = 'tools off'

const CMD_NOTIFY = 'notify'

const DEFAULTS = Object.freeze({
  port: '',

  vendorId: VENDOR_ID,

  productId: PRODUCT_ID,

  baudRate: 115200,

  alarmTimeoutMs: 60000,

  reconnectIntervalMs: 5000,
})

const THINKING_EVENTS = new Set([
  'step/start',
  'step/end',
  'assistant/attempt',
  'assistant/message',
  'turn/start',
])

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

const EVENT_TOPOLOGY = new Map()
for (const pair of ID_PAIRS) {
  EVENT_TOPOLOGY.set(pair.start, { role: 'start', pair })
  EVENT_TOPOLOGY.set(pair.end, { role: 'end', pair })
}

const STATE_HANDLED_ENDS = new Set()

const SUCCESS_EVENTS = new Set([
  'turn/end',
])

const OFF_EVENTS = new Set([
  'session/end-seed',
])

const RESULT_EVENTS = new Set(ID_PAIRS.map((p) => p.end))

const ERROR_EVENTS = new Set([
  'llm/retry',
  'llm/retry-started',
])

const ALARM_EVENTS = new Set([
  'approval/asked',
])

const ALARM_CLEAR_EVENTS = new Set([
  'approval/decided',
])

const PLAN_MODE_EVENT = 'plan/mode'

const NOTIFY_ONLY_EVENTS = new Set([
  'goal/change',
  'sandbox/mode',
])

function looksLikeFailure(data) {
  if (!data || typeof data !== 'object') return false

  if (data.error || data.isError === true || data.failed === true) return true
  const status = data.status
  if (typeof status === 'string') {
    const s = status.toLowerCase()
    if (s === 'error' || s === 'failed' || s === 'failure') return true
  }

  const outcome = data.outcome
  if (typeof outcome === 'string' && /error|fail/i.test(outcome)) return true
  return false
}

class LedTransport extends EventEmitter {
  #port = null
  #connecting = false
  #disposed = false
  #retryTimer = null
  #pendingState = null
  #ready = false

  constructor(config, log) {
    super()
    this.config = config
    this.log = log
  }

  get isReady() {
    return this.#ready
  }

  start() {
    if (this.#disposed) return
    void this.#attemptConnect()
  }

  send(state) {
    this.#pendingState = state
    this.#flush()
  }

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
      } catch {}
    }
  }

  #scheduleRetry() {
    if (this.#disposed || this.#retryTimer !== null) return
    const delay = Math.max(1000, Number(this.config.reconnectIntervalMs) || DEFAULTS.reconnectIntervalMs)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#attemptConnect()
    }, delay)

    if (typeof this.#retryTimer.unref === 'function') this.#retryTimer.unref()
  }

  async #attemptConnect() {
    if (this.#disposed || this.#connecting || this.#port) return
    this.#connecting = true
    try {
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
        this.log('未发现状态灯设备（USB VID 303A）。请确认设备已插好 USB 线；每 5 秒重试。')
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
      this.log(`已连接状态灯设备：${path}`)
      this.emit('connected', path)

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
      } catch {}
    }
  }

  #onClosed() {
    if (this.#port) {
      this.#ready = false
      this.#port = null
      this.log('设备已断开，等待重新接入…')
    }
    if (!this.#disposed) this.#scheduleRetry()
  }

  #onLine(line) {
    const text = line.trim()
    if (!text) return
    if (text.includes('READY')) {
      this.log(`设备握手成功：${text}`)
      this.#ready = true
      this.#flush()
      return
    }

    if (text.startsWith('ERR')) this.log(`设备回报：${text}`)
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

async function pickPortPath(SerialPort, config, log) {
  const explicit = typeof config.port === 'string' ? config.port.trim() : ''
  if (explicit) return explicit

  const wantVid = String(config.vendorId || VENDOR_ID).toLowerCase()
  const wantPid = String(config.productId || PRODUCT_ID).toLowerCase()

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

    const path = String(p.path || '')
    return /usbmodem|usbserial|ttyACM|ttyUSB/i.test(path)
  })

  return match ? match.path : null
}

class StateMachine {
  #base = null
  #plan = false
  #alarmTimer = null
  #stateBeforeAlarm = STATE.THINKING

  #active = new Map()

  #unmatchedEnds = 0

  #toolsOn = false

  constructor(config, transport, log) {
    this.config = config
    this.transport = transport
    this.log = log
  }

  get current() {
    if (this.#base === null) return null

    if (this.#base === STATE.OFF) return this.#plan ? 'plan' : STATE.OFF
    return this.#plan ? `${this.#base}${PLAN_SUFFIX}` : this.#base
  }

  get toolsReported() {
    return this.#toolsOn
  }

  get activeCount() {
    let n = 0
    for (const set of this.#active.values()) n += set.size
    return n
  }

  get unmatchedEnds() {
    return this.#unmatchedEnds
  }

  #dispatch() {
    const cmd = this.current
    if (cmd === null) return
    this.transport.send(cmd)
    this.log(`状态 → ${cmd}`)
  }

  #forceDispatch() {
    this.#dispatch()
  }

  set(state) {
    if (this.#base === state) return
    this.#base = state
    this.#dispatch()
  }

  #trackStart(pair, id) {
    if (id === null) return
    let set = this.#active.get(pair)
    if (set === undefined) {
      set = new Set()
      this.#active.set(pair, set)
    }
    set.add(id)

    this.set(STATE.THINKING)
    this.#reportTools()
  }

  #trackEnd(pair, id) {
    const set = this.#active.get(pair)
    if (id === null || set === undefined || !set.has(id)) {
      this.#unmatchedEnds++
      return
    }
    set.delete(id)
    if (set.size > 0) return
    this.#active.delete(pair)
    this.#reportTools()
  }

  #reportTools() {
    const shouldBeOn = this.activeCount > 0
    if (shouldBeOn === this.#toolsOn) return
    this.#toolsOn = shouldBeOn
    this.transport.send(shouldBeOn ? CMD_TOOLS_ON : CMD_TOOLS_OFF)
    this.log(`工具状态 → ${shouldBeOn ? '在跑' : '结束'}`)
  }

  #resetTools() {
    this.#active.clear()
    this.#reportTools()
  }

  #notify(after = null) {
    if (after === null) {
      this.transport.send(CMD_NOTIFY)
    } else {
      const cmd = after.plan ? `${after.foreground}${PLAN_SUFFIX}` : after.foreground
      this.transport.send(`${CMD_NOTIFY} ${cmd}`)
    }
  }

  handle(event) {
    try {
      if (!event || typeof event !== 'object') return
      const type = event.type
      const data = event.data
      if (typeof type !== 'string') return

      if (type === PLAN_MODE_EVENT) {
        const active = !!(data && data.active === true)
        if (active === this.#plan) return
        this.#clearAlarmTimer()
        if (active) {
          this.#plan = true

          this.#base = this.#base === null ? STATE.OFF : this.#base
          this.#dispatch()
        } else {
          const after = { foreground: this.#base === null ? STATE.OFF : this.#base, plan: false }
          this.#plan = false
          this.#notify(after)
          this.log(`计划模式关闭 → 绿灯闪两下 → ${this.current}`)
        }
        return
      }

      if (NOTIFY_ONLY_EVENTS.has(type)) {
        this.#notify(null)
        this.log(`${type} → 绿灯闪两下（状态不变：${this.current ?? STATE.OFF}）`)
        return
      }

      if (type === 'turn/start' || type === 'turn/end') {
        this.#resetTools()
      }

      if (SUCCESS_EVENTS.has(type) && this.#plan) {
        this.#base = STATE.SUCCESS
        this.#notify({ foreground: STATE.SUCCESS, plan: this.#plan })
        this.log(`计划模式下答完一轮 → 绿灯闪两下 → 保持绿灯常亮`)
        return
      }

      if (ALARM_EVENTS.has(type)) {
        this.#stateBeforeAlarm = this.#base === STATE.ALARM ? this.#stateBeforeAlarm : (this.#base || STATE.THINKING)
        this.#clearAlarmTimer()

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
        return
      }

      if (RESULT_EVENTS.has(type)) {
        const topo = EVENT_TOPOLOGY.get(type)
        if (topo !== undefined && !STATE_HANDLED_ENDS.has(type)) {
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
        const topo = EVENT_TOPOLOGY.get(type)
        this.#trackStart(topo.pair, topo.pair.key(data))
        return
      }
      if (THINKING_EVENTS.has(type)) {
        this.set(STATE.THINKING)
        return
      }
      if (SUCCESS_EVENTS.has(type)) {
        this.#resetTools()
        this.set(STATE.SUCCESS)
        return
      }
      if (OFF_EVENTS.has(type)) {
        this.#resetTools()
        const hadPlan = this.#plan
        this.#plan = false
        this.#base = STATE.OFF
        this.#forceDispatch()
        if (hadPlan) this.log('会话结束 → 同时清掉计划模式')
        return
      }
    } catch (err) {
      this.log(`事件处理异常（已忽略）：${err && err.message ? err.message : err}`)
    }
  }

  dispose() {
    this.#clearAlarmTimer()
    this.#resetTools()
  }

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

/**
 * 供离线自测使用的导出（`scripts/selftest.mjs`、`simulate.mjs` 等会 import 这些）。
 * 正常运行时 DSH 只使用下面的 apply()。
 *
 * 这只是把内部已有的常量与类暴露出来，不改变任何行为 —— 没有它，测试套件只能
 * 靠"读源码做正则断言"来验证，那正是之前误判过好几次的做法。
 */
export const __testing = Object.freeze({
  EVENT_SETS: {
    THINKING: THINKING_EVENTS,
    // BUSY 这个名字保留指向所有"开工"事件，方便自测按老习惯遍历；
    // 权威定义在 ID_PAIRS 里。
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

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[dsh-led-bridge] ${msg}`)
    } catch {}
  }

  const transport = new LedTransport(cfg, log)
  const machine = new StateMachine(cfg, transport, log)

  ctx.on('session/event', (_session, event) => machine.handle(event))

  transport.on('connected', () => {

    transport.send(machine.current || STATE.OFF)
  })

  transport.start()
  log('已启动，等待状态灯设备接入…')

  return () => {
    machine.dispose()
    transport.dispose()
  }
}
