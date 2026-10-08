import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../firmware/esp32c3_dsh_status_light/esp32c3_dsh_status_light.ino', import.meta.url), 'utf8')
const page = source.match(/const char CONFIG_PAGE\[\].*?R"HTML\(([\s\S]*?)\)HTML";/)[1]
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1]
function browser(fetch) {
  const elements = new Map()
  const element = () => ({ value: '', children: [], appendChild(x) { this.children.push(x) }, replaceChildren() { this.children = [] } })
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) },
    createElement() { return element() },
  }
  vm.runInNewContext(script, { document, fetch, URLSearchParams, setTimeout: (fn) => fn(), confirm: () => true })
  return document
}

test('opening the config page does not start network scans or extra requests', () => {
  const requests = []
  browser((...args) => requests.push(args))
  assert.deepEqual(requests, [])
})

test('scan results are visible buttons with exact SSID values', async () => {
  const names = ['wifi-A', 'a"\\b', '<img src=x onerror=alert(1)>']
  const d = browser(async (url) => ({ json: async () => url === '/scanresult' ? names : { scanning: true } }))
  await d.getElementById('scanbtn').onclick()
  assert.deepEqual(d.getElementById('nets').children.map((o) => o.value), names)
  assert.equal(d.getElementById('net-results').hidden, false)
  const buttons = d.getElementById('nets').children
  assert.equal(buttons[2].textContent, names[2])
  assert.equal(buttons[2].type, 'button')
  buttons[2].onclick()
  assert.equal(d.getElementById('ssid').value, names[2])
  assert.equal(d.getElementById('scanbtn').disabled, false)
})

test('scanning lists each distinct SSID once and keeps manual input', async () => {
  const d = browser(async (url) => ({ json: async () => url === '/scanresult' ? ['wifi-A', 'wifi-A', '', 'WIFI-A', 'wifi-B'] : { scanning: true } }))
  d.getElementById('ssid').value = 'manual-network'
  await d.getElementById('scanbtn').onclick()
  assert.deepEqual(d.getElementById('nets').children.map((o) => o.value), ['wifi-A', 'WIFI-A', 'wifi-B'])
  assert.equal(d.getElementById('ssid').value, 'manual-network')
})

test('saving uses a POST body and preserves password spaces and punctuation', async () => {
  let request
  const d = browser(async (...args) => { request = args; return { ok: true } })
  d.getElementById('ssid').value = 'phone hotspot'
  d.getElementById('pass').value = ' trailing &+ space '
  await d.getElementById('wifi-form').onsubmit({ preventDefault() {} })
  assert.equal(request[0], '/save'); assert.equal(request[1].method, 'POST')
  assert.equal(request[1].body.get('ssid'), 'phone hotspot')
  assert.equal(request[1].body.get('pass'), ' trailing &+ space ')
})
