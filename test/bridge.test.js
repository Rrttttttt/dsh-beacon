import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import { __testing as t } from '../lib/index.js'

const config = { ...t.DEFAULTS, alarmTimeoutMs: 0 }
function machine(extra = {}) {
  const writes = []
  return { writes, m: new t.StateMachine({ ...config, ...extra }, { send: (s) => writes.push(s) }, () => {}) }
}
function call(id) { return { type: 'tool/call', data: { callId: id } } }
function result(id, isError = false) {
  return { type: 'tool/result', data: { message: { id: `msg-${id}`, role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, isError, content: [] } } }
}
class Fake extends t.Transport {
  writes = []
  get label() { return 'fake' }
  async _connect() { return { label: 'fake' } }
  _write(_conn, line, done) { this.writes.push(line.trim()); done?.() }
  _teardown() {}
}
async function ready(f) { f.start(); await tick(); f._onLine('ESP32_STATUS_LIGHT READY fw=2.1.0 mode=usb config=0') }

test('concurrent official tool messages remain active until the last result', () => {
  const { m } = machine()
  m.handle(call('a')); m.handle(call('b')); m.handle(result('a'))
  assert.equal(m.activeCount, 1)
  m.handle(result('b')); assert.equal(m.activeCount, 0); assert.equal(m.toolsReported, false)
})
test('turn outcomes distinguish success, failure and cancellation', () => {
  for (const [kind, expected] of [['completed', 'success'], ['error', 'error'], ['aborted', 'off'], ['blocked', 'error'], ['max-tokens', 'error']]) {
    const { m } = machine(); m.handle({ type: 'turn/start' }); m.handle({ type: 'turn/end', data: { reason: { kind } } })
    assert.equal(m.current, expected, kind)
  }
})
test('tool and command failures use official nested and kind fields', () => {
  const { m } = machine(); m.handle(call('a')); m.handle(result('a', true)); assert.equal(m.current, 'error')
  const { m: c } = machine(); c.handle({ type: 'command/run', data: { commandId: 'c' } }); c.handle({ type: 'command/done', data: { commandId: 'c', kind: 'error' } }); assert.equal(c.current, 'error')
})
test('hook activity uses handlerId', () => {
  const { m } = machine(); m.handle({ type: 'hook/invoked', data: { handlerId: 'h' } }); assert.equal(m.activeCount, 1)
  m.handle({ type: 'hook/result', data: { handlerId: 'h', decision: 'pass', exitCode: 0 } }); assert.equal(m.activeCount, 0)
})
test('seed boundary preserves a live plan', () => {
  const { m } = machine(); m.handle({ type: 'plan/mode', data: { active: true } }); m.handle({ type: 'session/end-seed' }); assert.equal(m.current, 'plan')
})
test('pending approvals are paired and a terminal turn clears them', () => {
  const { m } = machine(); m.handle({ type: 'turn/start' }); m.handle(call('a'))
  m.handle({ type: 'approval/asked', data: { id: 'p1' } }); m.handle({ type: 'approval/asked', data: { id: 'p2' } })
  m.handle({ type: 'approval/decided', data: { id: 'p1' } }); assert.equal(m.current, 'alarm')
  m.handle({ type: 'approval/decided', data: { id: 'p2' } }); assert.equal(m.current, 'thinking'); assert.equal(m.activeCount, 1)
  m.handle({ type: 'approval/asked', data: { id: 'p3' } }); m.handle({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }); assert.equal(m.current, 'off')
})
test('changing plan does not dismiss an approval and timeout does not invent approval', async () => {
  const { m } = machine({ alarmTimeoutMs: 10 })
  m.handle({ type: 'approval/asked', data: { id: 'p' } }); m.handle({ type: 'plan/mode', data: { active: true } })
  await new Promise((r) => setTimeout(r, 25)); assert.equal(m.current, 'alarm+plan'); m.dispose()
})
test('transport waits for device identity, then replays the whole snapshot on READY', async () => {
  const f = new Fake(config, () => {}); try {
    f.start(); await tick(); assert.equal(f.isReady, false)
    f._onLine('some other device READY'); assert.equal(f.isReady, false)
    f.send('thinking'); f.send('tools on'); f._onLine('ESP32_STATUS_LIGHT READY fw=2.1.0 mode=usb config=0')
    assert.deepEqual(f.writes.slice(-2), ['thinking', 'tools on'])
    f.writes.length = 0; f._onLine('ESP32_STATUS_LIGHT READY fw=2.1.0 mode=usb config=0')
    assert.deepEqual(f.writes, ['thinking', 'tools on'])
  } finally { f.dispose() }
})
test('notifications are actions; heartbeat forces state refresh; actions are not replayed', async () => {
  const f = new Fake(config, () => {}); try {
    await ready(f); f.writes.length = 0
    f.send('thinking'); f.send('thinking'); f.send('notify'); f.send('notify'); f.send('thinking', { force: true })
    assert.deepEqual(f.writes, ['thinking', 'notify', 'notify', 'thinking'])
    f._onClosed(); f.send('notify'); await ready(f)
    assert.equal(f.writes.filter((x) => x === 'notify').length, 2)
  } finally { f.dispose() }
})
test('disposing during an asynchronous connection tears down the arriving handle', async () => {
  let finish, closed = 0
  class Late extends Fake { _connect() { return new Promise((r) => { finish = r }) } _teardown(c) { if (c) closed++ } }
  const f = new Late(config, () => {}); f.start(); f.dispose(); finish({ label: 'late' }); await tick()
  assert.equal(f.isReady, false); assert.equal(closed, 1)
})
test('channel sync restores tools when switching transports', async () => {
  const serial = new Fake(config, () => {}), tcp = new Fake(config, () => {})
  const channel = new t.ChannelTransport({ ...config, host: 'fixture' }, () => {}, { serial, tcp })
  const m = new t.StateMachine(config, channel, () => {})
  channel.on('connected', () => m.sync())
  try {
    channel.start(); await tick(); serial._onLine('ESP32_STATUS_LIGHT READY'); tcp._onLine('ESP32_STATUS_LIGHT READY')
    m.handle(call('a')); tcp.writes.length = 0; serial._onClosed()
    assert.deepEqual(tcp.writes, ['thinking', 'tools on'])
  } finally { channel.dispose(); m.dispose() }
})
test('multi-session aggregation keeps one session tool active when another ends', () => {
  const writes = [], c = new t.SessionController(config, { send: (x) => writes.push(x) }, () => {})
  c.handle({ id: 'a' }, { type: 'turn/start' }); c.handle({ id: 'a' }, call('a-tool'))
  c.handle({ id: 'b' }, { type: 'turn/start' }); c.handle({ id: 'b' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(c.current, 'thinking'); assert.equal(c.toolsReported, true)
  c.handle({ id: 'a' }, result('a-tool')); c.handle({ id: 'a' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(c.current, 'success'); assert.equal(c.toolsReported, false); c.dispose()
})
test('real TCP reconnect restores the complete state snapshot', { timeout: 5000 }, async () => {
  const received = []
  const sockets = new Set()
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8'); let buf = ''
    socket.on('data', (data) => { buf += data; let end; while ((end = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, end); buf = buf.slice(end + 1); received.push(line); if (line === 'hello') socket.write('ESP32_STATUS_LIGHT READY fw=2.1.0 mode=wifi config=0\n'); else socket.write(`OK ${line}\n`) } })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const f = t.createTcpTransport({ ...config, reconnectIntervalMs: 1000, host: '127.0.0.1', tcpPort: server.address().port }, () => {})
  try {
    const connected = new Promise((r) => f.once('connected', r)); f.send('thinking'); f.send('tools on'); f.start(); await connected
    await new Promise((r) => setTimeout(r, 30)); assert.deepEqual(received.slice(-2), ['thinking', 'tools on'])
    received.length = 0
    const reconnected = new Promise((r) => f.once('connected', r))
    for (const socket of sockets) socket.destroy()
    await reconnected
    await new Promise((r) => setTimeout(r, 30)); assert.deepEqual(received, ['hello', 'thinking', 'tools on'])
  } finally { f.dispose(); for (const socket of sockets) socket.destroy(); await new Promise((r) => server.close(r)) }
})

test('write callback failure closes the channel and preserves a retryable snapshot', async () => {
  const diagnostics = { ...t.diagState, cmdLog: [] }
  class Fails extends Fake {
    _write(_conn, line, done) { this.writes.push(line.trim()); done?.(line.trim() === 'thinking' ? new Error('write failed') : null) }
  }
  const f = new Fails({ ...config, diagnostics }, () => {})
  try {
    await ready(f); f.send('thinking')
    assert.equal(f.isReady, false)
    assert.equal(diagnostics.cmdLog.at(-1).outcome, 'write-error')
    assert.equal(diagnostics.lastError, 'write failed')
  } finally { f.dispose() }
})

test('an approval stays pending after the former alarm timeout', async () => {
  const { m } = machine({ alarmTimeoutMs: 10 })
  try {
    m.handle({ type: 'approval/asked', data: { id: 'p' } })
    await new Promise((r) => setTimeout(r, 25))
    assert.equal(m.current, 'alarm'); assert.equal(m.hasApprovals, true)
  } finally { m.dispose() }
})

test('terminal and alarm states invalidate the tool cache', async () => {
  const f = new Fake(config, () => {})
  try {
    await ready(f); f.send('thinking'); f.send('tools on'); f.writes.length = 0
    f.send('alarm'); f.send('tools on')
    assert.deepEqual(f.writes, ['alarm', 'tools on'])
  } finally { f.dispose() }
})

test('queued snapshots always replay state before tools', async () => {
  const f = new Fake(config, () => {})
  try {
    f.send('tools on'); f.send('alarm'); await ready(f)
    assert.deepEqual(f.writes.slice(-2), ['alarm', 'tools on'])
  } finally { f.dispose() }
})

test('a config-mode device cannot become the active control channel', async () => {
  const f = new Fake(config, () => {})
  try {
    f.start(); await tick(); f._onLine('CONFIG AP=DSH-Beacon-test password=not-a-real-secret')
    assert.equal(t.diagState.lastReply, 'CONFIG AP=DSH-Beacon-test password=[redacted]')
    f._onLine('ESP32_STATUS_LIGHT READY config=1')
    assert.equal(f.isReady, false)
  } finally { f.dispose() }
})

test('explicit transport selection opens only the requested channel', async () => {
  for (const mode of ['serial', 'tcp']) {
    const serial = new Fake(config, () => {}), tcp = new Fake(config, () => {})
    const channel = new t.ChannelTransport({ ...config, host: 'fixture', transport: mode }, () => {}, { serial, tcp })
    try {
      channel.start(); await tick()
      assert.equal(serial.writes.includes('hello'), mode === 'serial')
      assert.equal(tcp.writes.includes('hello'), mode === 'tcp')
    } finally { channel.dispose() }
  }
  const cfg = { ...config, host: 'invalid host', transport: 'tcp' }
  t.validateConfig(cfg, () => {}); assert.equal(cfg.transport, 'serial')
})
