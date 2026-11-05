import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { once } from 'node:events'
import { WebSocket } from '/workspace/omsite/node_modules/ws/wrapper.mjs'
import { createDeviceRelay } from '/workspace/omsite/server/lib/device-relay.mjs'
import {
  ALLOWED_HOSTS, isAllowedOpen, parseBinaryFrame, encodeBinaryFrame, createDeviceProxyRelay, openSocket,
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
  const port = http.address().port
  t.after(() => http.close())

  const echoServer = createNetServer(s => s.pipe(s))
  echoServer.listen(0, '127.0.0.1'); await once(echoServer, 'listening')
  const echoPort = echoServer.address().port
  t.after(() => echoServer.close())

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
