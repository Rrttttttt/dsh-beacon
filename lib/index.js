import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

  host: '',
  transport: 'auto',

  tcpPort: 8234,

  port: '',

  vendorId: VENDOR_ID,

  productId: PRODUCT_ID,

  baudRate: 115200,

  alarmTimeoutMs: 60000,

  reconnectIntervalMs: 5000,
  handshakeTimeoutMs: 5000,
  heartbeatIntervalMs: 30000,
  sessionId: '',
  diagnosticPath: '',
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
    endKey: (d) => d?.message?.source?.callId ?? d?.message?.toolCallId ?? d?.message?.content?.[0]?.toolCallId ?? d?.callId ?? null,
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
    key: (d) => d?.handlerId ?? d?.hookId ?? d?.id ?? null,
    endKey: (d) => d?.handlerId ?? d?.hookId ?? d?.id ?? null,
  },
]

const EVENT_TOPOLOGY = new Map()
for (const pair of ID_PAIRS) {
  EVENT_TOPOLOGY.set(pair.start, { role: 'start', pair })
  EVENT_TOPOLOGY.set(pair.end, { role: 'end', pair })
}

const STATE_HANDLED_ENDS = new Set()

const DIAG_PATH = join(homedir(), '.dsh', 'dsh-led-bridge.state.json')
const diagState = {

  codeVersion: 2,
  pid: process.pid,
  transport: '',
  ready: false,
  sends: 0,
  lastSent: null,
  lastSentAt: null,
  connectedAt: null,
  disconnects: 0,
  lastDisconnectAt: null,
  lastError: null,

  lastReply: null,
  lastReplyAt: null,
  replies: 0,

  lastReady: null,
  lastReadyAt: null,

  cmdLog: [],
}

const CMD_LOG_MAX = 12

let instanceNumber = 0
function startDiagnostics(config, log) {
  const state = config.diagnostics
  const path = config.diagnosticPath || DIAG_PATH.replace('.state.json', '.' + process.pid + '.' + (++instanceNumber) + '.state.json')
  let failed = false
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(state, null, 2))
    } catch (err) {
      if (!failed) log('诊断文件写入失败：' + err.message)
      failed = true
    }
  }
  const timer = setInterval(flush, 2000)
  timer.unref?.()
  flush()
  return () => { clearInterval(timer); flush() }
}

const SUCCESS_EVENTS = new Set([
  'turn/end',
])

const OFF_EVENTS = new Set()

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

  if (data.error || data.isError === true || data.message?.isError === true || data.failed === true || data.kind === 'error' || data.exitCode != null && data.exitCode !== 0) return true
  const status = data.status
  if (typeof status === 'string') {
    const s = status.toLowerCase()
    if (s === 'error' || s === 'failed' || s === 'failure') return true
  }

  const outcome = data.outcome
  if (typeof outcome === 'string' && /error|fail/i.test(outcome)) return true
  return false
}

class Transport extends EventEmitter {
  #conn = null
  #connecting = false
  #disposed = false
  #retryTimer = null
  #handshakeTimer = null
  #pending = new Map()
  #sent = new Map()
  #ready = false

  constructor(config, log) {
    super()
    this.config = config
    this.log = log
    this.diag = config.diagnostics ?? diagState
  }

  get isReady() { return this.#ready }
  start() { if (!this.#disposed) void this.#attemptConnect() }

  send(command, options = {}) {
    const key = command.startsWith('tools ') ? 'tools' : /^(off|plan|thinking|busy|error|alarm|success)(\+plan)?$/.test(command) ? 'state' : null
    this.diag.sends++
    this.diag.lastSent = command
    this.diag.lastSentAt = new Date().toISOString()
    const entry = { t: Date.now(), cmd: command, via: this.label, outcome: 'pending' }
    this.diag.cmdLog.push(entry)
    if (this.diag.cmdLog.length > CMD_LOG_MAX) this.diag.cmdLog.shift()
    if (key !== null) this.#pending.set(key, command)
    if (!this.#ready) { entry.outcome = key === null ? 'dropped-action' : 'pending-connection'; return }
    this.#write(command, key, options.force === true, entry)
  }

  dispose() {
    this.#disposed = true
    clearTimeout(this.#retryTimer)
    clearTimeout(this.#handshakeTimer)
    this.#retryTimer = this.#handshakeTimer = null
    const conn = this.#conn
    this.#conn = null
    this.#ready = false
    this._teardown(conn)
  }

  #scheduleRetry() {
    if (this.#disposed || this.#retryTimer !== null) return
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#attemptConnect()
    }, Math.max(1000, Number(this.config.reconnectIntervalMs) || DEFAULTS.reconnectIntervalMs))
    this.#retryTimer.unref?.()
  }

  async #attemptConnect() {
    if (this.#disposed || this.#connecting || this.#conn) return
    this.#connecting = true
    try {
      const conn = await this._connect()
      if (!conn) return
      if (this.#disposed) { this._teardown(conn); return }
      this.#conn = conn
      this._onOpen(conn)
    } catch (err) {
      this.diag.lastError = err.message
      this.log(this.label + '连接失败：' + err.message)
      if (this.#conn) this._onClosed(this.#conn)
    } finally {
      this.#connecting = false
      if (!this.#conn) this.#scheduleRetry()
    }
  }

  async _connect() { throw new Error('_connect() 未实现') }
  _teardown(_conn) {}
  _write(_conn, _line, done) { done?.() }

  _onOpen(conn) {
    this.#sent.clear()
    this.#ready = false
    this.#handshakeTimer = setTimeout(() => {
      this.log(this.label + '设备身份握手超时')
      this._onClosed(conn)
    }, this.config.handshakeTimeoutMs || DEFAULTS.handshakeTimeoutMs)
    this.#handshakeTimer.unref?.()
    this._write(conn, 'hello\n', (err) => { if (err) this._onClosed(conn) })
  }

  _onClosed(conn = this.#conn) {
    if (!conn || conn !== this.#conn) return
    clearTimeout(this.#handshakeTimer)
    this.#handshakeTimer = null
    this.#conn = null
    this.#ready = false
    this.#sent.clear()
    this.diag.ready = false
    this.diag.disconnects++
    this.diag.lastDisconnectAt = new Date().toISOString()
    this._teardown(conn)
    this.emit('channelDown')
    this.#scheduleRetry()
  }

  _onLine(line) {
    const text = String(line).trim().replace(/(CONFIG AP=\S+ password=)\S+/, '$1[redacted]')
    if (!text || !this.#conn || this.#disposed) return
    this.diag.lastReply = text
    this.diag.lastReplyAt = new Date().toISOString()
    this.diag.replies++
    if (/^ESP32_STATUS_LIGHT READY(?:\s|$)/.test(text)) {
      if (/\bconfig=1\b/.test(text)) { this._onClosed(); return }
      clearTimeout(this.#handshakeTimer)
      this.#handshakeTimer = null
      this.#ready = true
      this.#sent.clear()
      this.diag.transport = this.label
      this.diag.ready = true
      this.diag.lastReady = text
      this.diag.lastReadyAt = new Date().toISOString()
      this.diag.connectedAt = new Date().toISOString()
      this.log('设备身份已确认：' + this.#conn.label)
      this.emit('connected', this.#conn.label)
      for (const key of ['state', 'tools']) {
        const command = this.#pending.get(key)
        if (command) this.#write(command, key, false)
      }
    } else if (text.startsWith('OK ') || text.startsWith('ERR ')) {
      const command = text.slice(text.indexOf(' ') + 1)
      const entry = this.diag.cmdLog.findLast((e) => e.cmd === command && e.outcome === 'written')
      if (entry) entry.outcome = text.startsWith('OK ') ? 'acknowledged' : 'device-error'
      if (text.startsWith('ERR ')) {
        for (const [key, sent] of this.#sent) if (sent === command) this.#sent.delete(key)
        this.diag.lastError = text
        this.log('设备回报：' + text)
      }
    }
  }

  #write(command, key, force, entry = null) {
    const conn = this.#conn
    if (!conn || !this.#ready) return
    if (key !== null && !force && this.#sent.get(key) === command) {
      if (entry) entry.outcome = 'suppressed'
      return
    }
    if (key !== null) this.#sent.set(key, command)
    // These firmware states reset its tool flag; resend the tools snapshot next.
    if (key === 'state' && /^(off|error|alarm|success)(\+plan)?$/.test(command)) this.#sent.delete('tools')
    if (entry) entry.outcome = 'queued'
    try {
      this._write(conn, command + '\n', (err) => {
        if (err) {
          if (entry) entry.outcome = 'write-error'
          if (this.#sent.get(key) === command) this.#sent.delete(key)
          this.diag.lastError = err.message
          this.log('写入失败：' + err.message)
          this._onClosed(conn)
        } else if (entry) entry.outcome = 'written'
      })
    } catch (err) {
      if (entry) entry.outcome = 'write-error'
      this.diag.lastError = err.message
      this._onClosed(conn)
    }
  }

  get label() { return '' }
}

class SerialTransport extends Transport {
  get label() {
    return '状态灯设备'
  }

  async _connect() {
    const sp = await loadSerialPort()
    if (!sp) {
      this.log('未安装 serialport 依赖，无法使用串口。请在插件目录执行 pnpm install。')
      return null
    }
    const SerialPort = sp.SerialPort
    const ReadlineParser = sp.ReadlineParser
    if (typeof ReadlineParser !== 'function') {
      this.log('serialport 缺少 ReadlineParser，依赖可能已损坏。请在插件目录重装依赖。')
      return null
    }

    const path = await pickPortPath(SerialPort, this.config, this.log)
    if (!path) {
      this.log('未发现状态灯设备（USB VID 303A）。请确认设备已插好 USB 线；每 5 秒重试。')
      return null
    }

    const port = new SerialPort({ path, baudRate: Number(this.config.baudRate) || 115200, autoOpen: false })

    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }))
    parser.on('data', (raw) => this._onLine(raw))
    port.on('error', (err) => this.log(`串口错误：${err && err.message ? err.message : err}`))
    port.on('close', () => this._onClosed(port))

    await new Promise((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()))
    })

    port.label = path
    return port
  }

  _teardown(conn) {
    if (conn && conn.isOpen) {
      try {
        conn.close(() => {})
      } catch {}
    }
  }

  _write(conn, line, done) {
    conn.write(line, done)
  }
}

class TcpTransport extends Transport {
  #buf = ''

  get label() {
    return '状态灯（TCP）'
  }

  async _connect() {
    const host = String(this.config.host).trim()
    const port = Number(this.config.tcpPort) || DEFAULTS.tcpPort

    const socket = await new Promise((resolve, reject) => {
      const s = createConnection({ host, port })
      const timer = setTimeout(() => {
        s.destroy()
        reject(new Error('TCP连接超时'))
      }, this.config.handshakeTimeoutMs || DEFAULTS.handshakeTimeoutMs)
      s.once('connect', () => { clearTimeout(timer); resolve(s) })
      s.once('error', (err) => { clearTimeout(timer); s.destroy(); reject(err) })
    })

    socket.setKeepAlive(true, 10000)
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('error', (err) => this.log(`socket 错误：${err && err.message ? err.message : err}`))
    this.#buf = ''
    socket.on('close', () => this._onClosed(socket))

    socket.label = `${host}:${port}`
    return socket
  }

  _teardown(conn) {
    if (conn) {
      try {
        conn.destroy()
      } catch {}
    }
  }

  _write(conn, line, done) {
    conn.write(line, done)
  }

  #onData(chunk) {
    this.#buf += chunk.toString('utf8')
    let i
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).replace(/\r$/, '')
      this.#buf = this.#buf.slice(i + 1)
      this._onLine(line)
    }

    if (this.#buf.length > 4096) this.#buf = ''
  }
}

class ChannelTransport extends EventEmitter {
  #serial = null
  #tcp = null
  #active = null
  #disposed = false

  constructor(config, log, children = null) {
    super()
    this.config = config
    this.log = log
    this.children = children
  }
  get label() { return '状态灯' }
  get isReady() { return this.#active !== null }

  start() {
    if (this.#serial || this.#disposed) return
    this.#serial = this.children?.serial ?? new SerialTransport(this.config, this.log)
    this.#tcp = this.children?.tcp ?? new TcpTransport(this.config, this.log)
    for (const child of [this.#serial, this.#tcp]) {
      child.on('connected', () => this.#choose(child))
      child.on('channelDown', () => this.#choose())
    }
    if (this.config.transport !== 'tcp') this.#serial.start()
    if (this.config.transport !== 'serial' && String(this.config.host).trim()) this.#tcp.start()
  }

  send(command, options) { this.#active?.send(command, options) }

  dispose() {
    this.#disposed = true
    this.#active = null
    this.#serial?.dispose()
    this.#tcp?.dispose()
  }

  #choose(readyChild = null) {
    if (this.#disposed) return
    const previous = this.#active
    this.#active = this.#serial.isReady ? this.#serial : this.#tcp.isReady ? this.#tcp : null
    if (this.#active && (previous !== this.#active || readyChild === this.#active)) {
      this.emit('connected', this.#active.label)
    } else if (!this.#active && previous) {
      this.emit('channelDown')
    }
  }
}

function createTransport(config, log) {
  return new ChannelTransport(config, log)
}

function createTcpTransport(config, log) {
  return new TcpTransport(config, log)
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
  #active = new Map()
  #approvals = new Set()
  #unmatchedEnds = 0
  #toolsOn = false

  constructor(config, transport, log) {
    this.config = config
    this.transport = transport
    this.log = log
    this.inTurn = false
  }
  get current() {
    const base = this.#approvals.size > 0 ? STATE.ALARM : this.#base
    if (base === null) return null
    if (base === STATE.OFF) return this.#plan ? 'plan' : STATE.OFF
    return this.#plan ? base + PLAN_SUFFIX : base
  }
  get toolsReported() { return this.#toolsOn }
  get activeCount() { return [...this.#active.values()].reduce((n, ids) => n + ids.size, 0) }
  get unmatchedEnds() { return this.#unmatchedEnds }
  get hasApprovals() { return this.#approvals.size > 0 }

  sync(force = true) {
    this.transport.send(this.current || STATE.OFF, { force })
    this.transport.send(this.#toolsOn ? CMD_TOOLS_ON : CMD_TOOLS_OFF, { force })
  }
  #dispatch() {
    if (this.current !== null) this.transport.send(this.current)
  }
  set(state) {
    if (this.#base === state) return
    this.#base = state
    this.#dispatch()
  }
  #reportTools() {
    const on = this.activeCount > 0
    if (on === this.#toolsOn) return
    this.#toolsOn = on
    this.transport.send(on ? CMD_TOOLS_ON : CMD_TOOLS_OFF)
  }
  #resetTools() { this.#active.clear(); this.#reportTools() }
  #trackStart(pair, id) {
    if (id === null) return
    if (!this.#active.has(pair)) this.#active.set(pair, new Set())
    this.#active.get(pair).add(id)
    this.set(STATE.THINKING)
    this.#reportTools()
  }
  #trackEnd(pair, id) {
    const ids = this.#active.get(pair)
    if (id === null || !ids?.delete(id)) { this.#unmatchedEnds++; return }
    if (!ids.size) this.#active.delete(pair)
    this.#reportTools()
  }

  handle(event) {
    if (!event || typeof event.type !== 'string') return
    const { type, data } = event
    if (type === 'session/end-seed') return
    if (type === PLAN_MODE_EVENT) {
      const on = data?.active === true
      if (on === this.#plan) return
      this.#plan = on
      this.#base ??= STATE.OFF
      this.#dispatch()
      if (!on) this.transport.send(CMD_NOTIFY + ' ' + this.current)
      return
    }
    if (NOTIFY_ONLY_EVENTS.has(type)) { this.transport.send(CMD_NOTIFY); return }
    if (type === 'turn/start') {
      this.inTurn = true
      this.#approvals.clear()
      this.#resetTools()
      this.set(STATE.THINKING)
      this.#dispatch()
      return
    }
    if (type === 'turn/end') {
      this.inTurn = false
      this.#approvals.clear()
      this.#resetTools()
      const kind = data?.reason?.kind
      const base = kind === 'completed' ? STATE.SUCCESS : kind === 'aborted' || kind === 'interrupted' || kind === 'forked' ? STATE.OFF : STATE.ERROR
      this.set(base)
      this.#dispatch()
      if (base === STATE.SUCCESS && this.#plan) this.transport.send(CMD_NOTIFY + ' ' + this.current)
      return
    }
    if (ALARM_EVENTS.has(type)) {
      this.#approvals.add(data?.id ?? 'legacy')
      this.#base ??= STATE.THINKING
      this.#dispatch()
      return
    }
    if (ALARM_CLEAR_EVENTS.has(type)) {
      this.#approvals.delete(data?.id ?? 'legacy')
      this.#dispatch()
      return
    }
    const topo = EVENT_TOPOLOGY.get(type)
    if (topo?.role === 'start') { this.#trackStart(topo.pair, topo.pair.key(data)); return }
    if (topo?.role === 'end') {
      this.#trackEnd(topo.pair, topo.pair.endKey(data))
      if (looksLikeFailure(data)) this.set(STATE.ERROR)
      return
    }
    if (ERROR_EVENTS.has(type)) { this.set(STATE.ERROR); return }
    if (THINKING_EVENTS.has(type)) this.set(STATE.THINKING)
  }
  dispose() { this.#approvals.clear(); this.#active.clear(); this.#toolsOn = false }
}

class SessionController {
  #sessions = new Map()
  #clock = 0
  constructor(config, transport, log) {
    this.config = config
    this.transport = transport
    this.log = log
  }
  #selected() {
    const entries = [...this.#sessions.values()]
    const active = entries.filter(({ m }) => m.inTurn || m.activeCount || m.hasApprovals)
    const candidates = active.length ? active : entries
    const rank = (m) => m.current?.startsWith('alarm') ? 3 : m.current?.startsWith('error') ? 2 : 1
    return candidates.sort((a, b) => (active.length ? rank(b.m) - rank(a.m) : 0) || b.updated - a.updated)[0]?.m
  }
  get current() { return this.#selected()?.current ?? STATE.OFF }
  get toolsReported() { return [...this.#sessions.values()].some(({ m }) => m.toolsReported) }
  sync(force = true) {
    this.transport.send(this.current, { force })
    this.transport.send(this.toolsReported ? CMD_TOOLS_ON : CMD_TOOLS_OFF, { force })
  }
  handle(session, event) {
    const key = session?.id ?? session ?? 'default'
    if (this.config.sessionId && key !== this.config.sessionId) return
    if (!event || event.type === 'session/end-seed' || !EVENT_TOPOLOGY.has(event.type) && !THINKING_EVENTS.has(event.type) && !SUCCESS_EVENTS.has(event.type) && !ALARM_EVENTS.has(event.type) && !ALARM_CLEAR_EVENTS.has(event.type) && !ERROR_EVENTS.has(event.type) && !NOTIFY_ONLY_EVENTS.has(event.type) && event.type !== PLAN_MODE_EVENT) return
    let entry = this.#sessions.get(key)
    if (!entry) {
      const sink = { send: (command) => {
        this.sync(false)
        if (command === CMD_NOTIFY || command.startsWith(CMD_NOTIFY + ' ')) this.transport.send(CMD_NOTIFY + ' ' + this.current)
      } }
      entry = { m: new StateMachine(this.config, sink, this.log), updated: 0 }
      this.#sessions.set(key, entry)
    }
    entry.updated = ++this.#clock
    entry.m.handle(event)
    this.sync(false)
    // Bound retained idle history without dropping an active session.
    if (this.#sessions.size > 128) {
      for (const [id, item] of this.#sessions) {
        if (id !== key && !item.m.inTurn && !item.m.activeCount && !item.m.hasApprovals) {
          item.m.dispose(); this.#sessions.delete(id); break
        }
      }
    }
  }
  dispose() { for (const { m } of this.#sessions.values()) m.dispose(); this.#sessions.clear() }
}

export const __testing = Object.freeze({
  EVENT_SETS: {
    THINKING: THINKING_EVENTS,

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
  createTransport,
  createTcpTransport,
  validateConfig,
  diagState,
  DIAG_PATH,
  Transport,
  ChannelTransport,
  SerialTransport,
  TcpTransport,
  StateMachine,
  SessionController,
})

function validateConfig(cfg, log) {
  if (!['auto', 'serial', 'tcp'].includes(cfg.transport)) cfg.transport = 'auto'
  const interval = Number(cfg.heartbeatIntervalMs)
  cfg.heartbeatIntervalMs = Number.isFinite(interval) && interval >= 1000 && interval <= 60000 ? interval : DEFAULTS.heartbeatIntervalMs
  const host = typeof cfg.host === 'string' ? cfg.host.trim() : ''
  cfg.host = host
  if (!host && cfg.transport === 'tcp') { log('TCP 模式未配置 host，回退串口。'); cfg.transport = 'serial' }

  if (host) {
    if (/\s/.test(host)) {
      log(`host 含空白字符（"${host}"）—— 已忽略，回退到串口。`)
      cfg.host = ''
      if (cfg.transport === 'tcp') cfg.transport = 'serial'
      return
    }
    const port = Number(cfg.tcpPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      log(`tcpPort 非法（${cfg.tcpPort}）—— 已改用默认 ${DEFAULTS.tcpPort}。`)
      cfg.tcpPort = DEFAULTS.tcpPort
    }
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`[dsh-led-bridge] ${msg}`)
    } catch {}
  }

  validateConfig(cfg, log)

  cfg.diagnostics = { ...diagState, codeVersion: 3, cmdLog: [] }
  const stopDiagnostics = startDiagnostics(cfg, log)
  const transport = createTransport(cfg, log)
  const machine = new SessionController(cfg, transport, log)
  const stopEvents = ctx.on('session/event', (session, event) => machine.handle(session, event))
  transport.on('connected', () => machine.sync())
  const heartbeat = setInterval(() => machine.sync(), cfg.heartbeatIntervalMs)
  heartbeat.unref?.()

  transport.start()
  log(
    String(cfg.host).trim()
      ? `已启动（TCP → ${String(cfg.host).trim()}:${cfg.tcpPort}），等待状态灯接入…`
      : '已启动（串口自动发现），等待状态灯设备接入…',
  )

  return () => {
    clearInterval(heartbeat)
    if (typeof stopEvents === 'function') stopEvents()
    transport.send(STATE.OFF, { force: true })
    transport.dispose()
    machine.dispose()
    stopDiagnostics()
  }
}
