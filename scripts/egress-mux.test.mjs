import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createEgressMux, DEVICE_HOSTS, isDeviceHost } from './egress-mux.mjs'

test('device hosts exclude models.opencode.ai', () => {
  assert.deepEqual([...DEVICE_HOSTS].sort(), ['opencode.ai', 'openrouter.ai'])
  assert.equal(isDeviceHost('models.opencode.ai'), false)
})

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); server.unref()
  return server.address().port
}

function upstreamThatHits(hits, targetPort) {
  const s = createServer((_req, res) => res.end())
  s.on('connect', (req, socket) => {
    hits.push(String(req.url).split(':')[0].toLowerCase())
    const out = connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      out.pipe(socket); socket.pipe(out)
    })
    out.on('error', () => socket.destroy())
  })
  return s
}

async function tunnel(muxPort, hostname) {
  const { res, socket } = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: muxPort, method: 'CONNECT', path: `${hostname}:443` })
    req.on('connect', (res, socket) => resolve({ res, socket }))
    req.on('error', reject)
    req.end()
  })
  assert.equal(res.statusCode, 200, hostname)
  socket.write(`GET / HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`)
  let body = ''
  socket.on('data', d => { body += d })
  await once(socket, 'end')
  assert.match(body, /ok|direct/)
}

test('mux: opencode/openrouter → device; models → general (never device)', { timeout: 10000 }, async (t) => {
  const target = createServer((req, res) => res.end('ok'))
  const targetPort = await listen(target)
  t.after(() => target.close())

  const deviceHits = [], generalHits = []
  const deviceUp = upstreamThatHits(deviceHits, targetPort)
  const generalUp = upstreamThatHits(generalHits, targetPort)
  const dp = await listen(deviceUp), gp = await listen(generalUp)
  t.after(() => { deviceUp.close(); generalUp.close() })

  const { server, totals } = createEgressMux({
    deviceProxy: `http://127.0.0.1:${dp}`,
    generalProxy: `http://127.0.0.1:${gp}`,
  })
  const mp = await listen(server)
  t.after(() => server.close())

  await tunnel(mp, 'opencode.ai')
  await tunnel(mp, 'openrouter.ai')
  await tunnel(mp, 'models.opencode.ai')

  assert.deepEqual(deviceHits.sort(), ['opencode.ai', 'openrouter.ai'])
  assert.deepEqual(generalHits, ['models.opencode.ai'])
  assert.equal(totals.device, 2)
  assert.equal(totals.general, 1)
  assert.equal(totals.direct, 0)
})

test('mux without general: models direct; misc host forbidden; never device', { timeout: 10000 }, async (t) => {
  const target = createServer((req, res) => res.end('direct'))
  const targetPort = await listen(target)
  t.after(() => target.close())

  const deviceHits = []
  const deviceUp = upstreamThatHits(deviceHits, targetPort)
  const dp = await listen(deviceUp)
  t.after(() => deviceUp.close())

  const directHosts = []
  const { server, totals } = createEgressMux({
    deviceProxy: `http://127.0.0.1:${dp}`,
    generalProxy: null,
    connectDirect: ({ host, port }) => {
      directHosts.push(host)
      // Ignore advertised host/port; hit local echo target.
      return connect(targetPort, '127.0.0.1')
    },
  })
  const mp = await listen(server)
  t.after(() => server.close())

  await tunnel(mp, 'models.opencode.ai')
  assert.deepEqual(directHosts, ['models.opencode.ai'])
  assert.equal(deviceHits.length, 0, 'models must not touch the device upstream')
  assert.equal(totals.direct, 1)

  const forbidden = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: mp, method: 'CONNECT', path: 'example.com:443' })
    req.on('connect', (res, socket) => { resolve(res.statusCode); socket.destroy() })
    req.on('error', reject)
    req.end()
  })
  assert.equal(forbidden, 403)
  assert.equal(totals.forbidden, 1)
})
