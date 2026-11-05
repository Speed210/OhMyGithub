import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { once } from 'node:events'
import { WebSocket } from '/workspace/omsite/node_modules/ws/wrapper.mjs'
import { createDeviceRelay } from '/workspace/omsite/server/lib/device-relay.mjs'
import { EventEmitter } from 'node:events'
import {
  ALLOWED_HOSTS, INITIAL_CREDIT, WINDOW_BATCH, MAX_FRAME_PAYLOAD, isAllowedOpen, parseBinaryFrame, encodeBinaryFrame,
  createDeviceProxyRelay, openSocket,
} from './device-proxy-relay.mjs'

test('allowlist matches protocol', () => {
  assert.deepEqual([...ALLOWED_HOSTS].sort(), ['models.opencode.ai', 'opencode.ai', 'openrouter.ai'])
  assert.equal(isAllowedOpen('opencode.ai', 443), true)
  assert.equal(isAllowedOpen('github.com', 443), false)
  assert.equal(isAllowedOpen('opencode.ai', 80), false)
})

test('binary frames round-trip', () => {
  const buf = encodeBinaryFrame(9, Buffer.from('xy'))
  assert.deepEqual(parseBinaryFrame(buf), { id: 9, payload: Buffer.from('xy') })
})

test('local CONNECT through device proxy + mock phone reaches echo', { timeout: 15000 }, async (t) => {
  const relay = createDeviceRelay({ secret: 's', log: () => {} })
  const http = createServer((_req, res) => res.end())
  relay.attach(http)
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  http.unref()
  const port = http.address().port
  t.after(() => { try { http.closeAllConnections?.() } catch {}; http.close() })

  const echoServer = createNetServer(s => s.pipe(s))
  echoServer.listen(0, '127.0.0.1'); await once(echoServer, 'listening')
  echoServer.unref()
  const echoPort = echoServer.address().port
  t.after(() => { try { echoServer.closeAllConnections?.() } catch {}; echoServer.close() })

  const deviceTok = relay.issueDeviceToken({ id: 1, login: 'alice' }).token
  const device = new WebSocket(`ws://127.0.0.1:${port}/api/device-relay/ws`, { headers: { authorization: `Bearer ${deviceTok}` } })
  await once(device, 'open')
  device.send(JSON.stringify({ v: 1, type: 'hello', role: 'device', token: deviceTok }))
  assert.equal((await once(device, 'message').then(([d]) => JSON.parse(String(d)))).type, 'ready')
  const streams = new Map()
  device.on('message', (data, isBinary) => {
    if (isBinary) {
      const frame = parseBinaryFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
      const s = streams.get(frame.id)
      if (s?.socket && !s.socket.destroyed) s.socket.write(frame.payload)
      return
    }
    const msg = JSON.parse(String(data))
    if (msg.type === 'ping') { device.send(JSON.stringify({ v: 1, type: 'pong', t: msg.t })); return }
    if (msg.type === 'open') {
      const socket = netConnect({ host: '127.0.0.1', port: echoPort })
      socket.on('connect', () => {
        streams.set(msg.id, { socket })
        device.send(JSON.stringify({ v: 1, type: 'opened', id: msg.id }))
      })
      socket.on('data', chunk => {
        for (let off = 0; off < chunk.length; off += 64 * 1024) {
          device.send(encodeBinaryFrame(msg.id, chunk.subarray(off, off + 64 * 1024)), { binary: true })
        }
      })
      socket.on('close', () => { streams.delete(msg.id); device.send(JSON.stringify({ v: 1, type: 'close', id: msg.id, reason: 'eof' })) })
      socket.on('error', () => { streams.delete(msg.id); device.send(JSON.stringify({ v: 1, type: 'open_error', id: msg.id, code: 'refused', message: 'err' })) })
    }
  })
  t.after(() => { try { device.terminate() } catch {} })

  const issuer = relay.createIssuer({ identity: async () => ({}), readRun: () => ({ run: '1', attempt: 1 }), publicOrigin: `http://127.0.0.1:${port}` })
  const issued = await issuer.issue({ owner: 'alice', repo: 'PlayGround', number: '1', run: '1', attempt: 1, authorization: 'Bearer oidc' })
  assert.equal(issued.available, true)

  const { server, close } = createDeviceProxyRelay({
    token: issued.token,
    wsUrl: `ws://127.0.0.1:${port}/api/device-relay/ws`,
    openSocketImpl: openSocket,
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const localPort = server.address().port
  t.after(() => close())
  await new Promise(r => setTimeout(r, 80))

  const result = await new Promise((resolve, reject) => {
    const sock = netConnect({ host: '127.0.0.1', port: localPort })
    let buf = Buffer.alloc(0)
    sock.on('connect', () => {
      sock.write('CONNECT opencode.ai:443 HTTP/1.1\r\nHost: opencode.ai:443\r\n\r\n')
    })
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      const text = buf.toString('latin1')
      if (text.includes('\r\n\r\n') && text.startsWith('HTTP/1.1 200') && !sock._sent) {
        sock._sent = true
        sock.write('hello-echo')
        return
      }
      if (sock._sent && text.includes('hello-echo', text.indexOf('\r\n\r\n') + 4)) {
        resolve(buf.toString('latin1'))
        sock.end()
      } else if (text.includes('\r\n\r\n') && !text.startsWith('HTTP/1.1 200')) {
        reject(new Error(text.slice(0, 80)))
        sock.end()
      }
    })
    sock.on('error', reject)
    setTimeout(() => reject(new Error('CONNECT timeout: ' + buf.toString('latin1').slice(0, 120))), 8000)
  })
  assert.match(result, /HTTP\/1\.1 200/)
  assert.match(result, /hello-echo/)
})


function fakeRunnerSocket() {
  const ee = new EventEmitter()
  const sent = []
  const sock = {
    readyState: 0,
    sent,
    send(data, opts) {
      if (opts?.binary || Buffer.isBuffer(data)) sent.push({ binary: true, data: Buffer.from(data) })
      else sent.push({ binary: false, data: String(data) })
    },
    close() { sock.readyState = 3; ee.emit('close') },
    on: (...a) => ee.on(...a),
    once: (...a) => ee.once(...a),
    off: (...a) => ee.off(...a),
    _emit: (...a) => ee.emit(...a),
  }
  queueMicrotask(() => { sock.readyState = 1; ee.emit('open') })
  return sock
}

function controlSent(sock) {
  return sock.sent.filter(x => !x.binary).map(x => JSON.parse(x.data))
}

function binarySent(sock) {
  return sock.sent.filter(x => x.binary).map(x => parseBinaryFrame(x.data))
}

async function openTunnel(t, { creditPhone = true } = {}) {
  const sock = fakeRunnerSocket()
  const { server, totals, close, _streams } = createDeviceProxyRelay({
    token: 'tok',
    wsUrl: 'ws://example/api/device-relay/ws',
    openSocketImpl: () => sock,
  })
  let clientRef = null
  t.after(() => {
    try { clientRef?.destroy() } catch {}
    close()
  })
  await once(sock, 'open')
  assert.equal(controlSent(sock).at(-1)?.type, 'hello')
  sock._emit('message', JSON.stringify({ v: 1, type: 'ready', user: 'alice', max_streams: 8 }), false)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  server.unref()
  const localPort = server.address().port

  const clientP = new Promise((resolve, reject) => {
    const c = netConnect({ host: '127.0.0.1', port: localPort })
    let buf = Buffer.alloc(0)
    c.on('connect', () => c.write('CONNECT opencode.ai:443 HTTP/1.1\r\nHost: opencode.ai:443\r\n\r\n'))
    c.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      if (buf.toString('latin1').startsWith('HTTP/1.1 200') && buf.includes('\r\n\r\n')) resolve(c)
    })
    c.on('error', reject)
    setTimeout(() => reject(new Error('no 200')), 3000)
  })
  // Wait for runner open, then answer opened so CONNECT gets 200.
  let openMsg
  for (let i = 0; i < 50; i++) {
    openMsg = controlSent(sock).find(m => m.type === 'open')
    if (openMsg) break
    await new Promise(r => setTimeout(r, 10))
  }
  assert.ok(openMsg, 'runner sent open')
  sock._emit('message', JSON.stringify({ v: 1, type: 'opened', id: openMsg.id }), false)
  const client = await clientP
  await new Promise(r => setTimeout(r, 20))
  const stream = _streams.get(openMsg.id)
  assert.ok(stream?.open)
  assert.equal(stream.credit, INITIAL_CREDIT)
  clientRef = client
  return { sock, client, stream, openMsg, totals, _streams, creditPhone }
}

test('grants window credit after consuming WINDOW_BATCH device frames', { timeout: 10000 }, async (t) => {
  const { sock, openMsg, stream } = await openTunnel(t)
  const before = controlSent(sock).length
  for (let i = 0; i < WINDOW_BATCH; i++) {
    sock._emit('message', encodeBinaryFrame(openMsg.id, Buffer.alloc(8, i)), true)
  }
  await new Promise(r => setTimeout(r, 20))
  const windows = controlSent(sock).slice(before).filter(m => m.type === 'window')
  assert.equal(windows.length, 1)
  assert.deepEqual(windows[0], { v: 1, type: 'window', id: openMsg.id, credit: WINDOW_BATCH })
  assert.equal(stream.consumed, 0)
  // Another partial batch does not grant yet
  for (let i = 0; i < WINDOW_BATCH - 1; i++) {
    sock._emit('message', encodeBinaryFrame(openMsg.id, Buffer.alloc(4, 1)), true)
  }
  await new Promise(r => setTimeout(r, 10))
  assert.equal(controlSent(sock).slice(before).filter(m => m.type === 'window').length, 1)
  assert.equal(stream.consumed, WINDOW_BATCH - 1)
})

test('sender stalls at 0 credit and resumes on window', { timeout: 10000 }, async (t) => {
  const { sock, client, stream, openMsg } = await openTunnel(t)
  t.after(() => { try { client.destroy() } catch {} })
  // Exact multiples of MAX_FRAME_PAYLOAD → one wire frame per chunk regardless of TCP coalescing.
  const payload = Buffer.alloc(MAX_FRAME_PAYLOAD, 7)
  for (let i = 0; i < INITIAL_CREDIT; i++) client.write(payload)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(binarySent(sock).length, INITIAL_CREDIT, 'initial credit frames on wire')
  assert.equal(stream.credit, 0)
  // Further writes must not appear until a window grant (pause or queue).
  client.write(payload)
  client.write(payload)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(binarySent(sock).length, INITIAL_CREDIT, 'stalled at 0 credit')
  sock._emit('message', JSON.stringify({ v: 1, type: 'window', id: openMsg.id, credit: 2 }), false)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(binarySent(sock).length, INITIAL_CREDIT + 2, 'resumed after window')
  // Stop the CONNECT client so late TCP bytes cannot race the add-credit check.
  try { stream.client.removeAllListeners('data') } catch {}
  try { stream.client.pause() } catch {}
  try { client.destroy() } catch {}
  await new Promise(r => setTimeout(r, 30))
  stream.queue.length = 0
  stream.credit = 3
  sock._emit('message', JSON.stringify({ v: 1, type: 'window', id: openMsg.id, credit: 5 }), false)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(stream.credit, 8, 'window adds to residual credit')
  // Replace semantics would leave credit at 5; adding yields 8.
  sock._emit('message', JSON.stringify({ v: 1, type: 'window', id: openMsg.id, credit: 1 }), false)
  await new Promise(r => setTimeout(r, 10))
  assert.equal(stream.credit, 9, 'second window also adds')
})
