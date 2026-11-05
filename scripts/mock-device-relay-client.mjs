#!/usr/bin/env node
// Standalone desktop "phone" for device-relay proof before the APK.
// Connects as role=device, answers open, TCP-forwards allowlisted hosts:443.
// Node built-ins only (reuses openSocket from device-proxy-relay.mjs — no `ws` package).
//
// Usage:
//   DEVICE_RELAY_TOKEN=... DEVICE_RELAY_WS=wss://omgithub.com/api/device-relay/ws \
//     node scripts/mock-device-relay-client.mjs
//   node scripts/mock-device-relay-client.mjs --token-file /path --ws wss://host/api/device-relay/ws
// MOCK_ECHO=1 pipes streams to a local echo instead of a real TCP connect.
import { connect, createServer } from 'node:net'
import { readFileSync } from 'node:fs'
import {
  PROTOCOL, ALLOWED_HOSTS, isAllowedOpen, parseBinaryFrame, encodeBinaryFrame, openSocket,
} from './device-proxy-relay.mjs'

function usage() {
  console.error(`Usage:
  DEVICE_RELAY_TOKEN=... DEVICE_RELAY_WS=wss://host/api/device-relay/ws node scripts/mock-device-relay-client.mjs
  node scripts/mock-device-relay-client.mjs --token-file PATH --ws wss://host/api/device-relay/ws
Env: MOCK_ECHO=1 (loopback echo instead of real TCP). Allowlist: ${ALLOWED_HOSTS.join(', ')}`)
}

const args = process.argv.slice(2)
let token = process.env.DEVICE_RELAY_TOKEN || ''
let wsUrl = process.env.DEVICE_RELAY_WS || ''
const echo = process.env.MOCK_ECHO === '1'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token-file' && args[i + 1]) { token = readFileSync(args[++i], 'utf8').trim(); continue }
  if (args[i] === '--token' && args[i + 1]) { token = args[++i]; continue }
  if (args[i] === '--ws' && args[i + 1]) { wsUrl = args[++i]; continue }
  if (args[i] === '-h' || args[i] === '--help') { usage(); process.exit(0) }
}
if (!token || !wsUrl) { usage(); process.exit(2) }

const streams = new Map()
let echoPort = 0
if (echo) {
  const echoServer = createServer(socket => socket.pipe(socket))
  await new Promise(r => echoServer.listen(0, '127.0.0.1', r))
  echoPort = echoServer.address().port
  console.error(`[mock-phone] echo on 127.0.0.1:${echoPort}`)
}

function openTcp(host, port) {
  if (echo) return connect({ host: '127.0.0.1', port: echoPort })
  return connect({ host, port, family: 0 })
}

const ws = openSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } })
ws.on('open', () => {
  ws.send(JSON.stringify({ v: PROTOCOL, type: 'hello', role: 'device', token }))
  console.error('[mock-phone] connected; hello sent')
})
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    const frame = parseBinaryFrame(Buffer.isBuffer(data) ? data : Buffer.from(data))
    if (!frame) return
    const s = streams.get(frame.id)
    if (s?.socket && !s.socket.destroyed) s.socket.write(frame.payload)
    return
  }
  let msg
  try { msg = JSON.parse(String(data)) } catch { return }
  if (msg.type === 'ready') { console.error(`[mock-phone] ready user=${msg.user}`); return }
  if (msg.type === 'ping') { ws.send(JSON.stringify({ v: PROTOCOL, type: 'pong', t: msg.t })); return }
  if (msg.type === 'close') {
    const s = streams.get(msg.id)
    if (s) { try { s.socket.destroy() } catch {} streams.delete(msg.id) }
    return
  }
  if (msg.type === 'error') {
    console.error(`[mock-phone] server error code=${msg.code} ${msg.message || ''}`)
    return
  }
  if (msg.type !== 'open') return

  const id = msg.id
  if (!isAllowedOpen(msg.host, msg.port) && !echo) {
    ws.send(JSON.stringify({ v: PROTOCOL, type: 'open_error', id, code: 'forbidden', message: 'not allowlisted' }))
    console.error(`[mock-phone] forbidden #${id} ${msg.host}:${msg.port}`)
    return
  }
  const host = echo ? '127.0.0.1' : String(msg.host).toLowerCase()
  const port = echo ? echoPort : Number(msg.port)
  const socket = openTcp(host, port)
  const timer = setTimeout(() => {
    socket.destroy()
    if (streams.has(id)) {
      streams.delete(id)
      ws.send(JSON.stringify({ v: PROTOCOL, type: 'open_error', id, code: 'timeout', message: 'connect timeout' }))
    }
  }, 15_000)
  socket.on('connect', () => {
    clearTimeout(timer)
    const local = `${socket.localAddress}:${socket.localPort}`
    streams.set(id, { socket, host: msg.host })
    ws.send(JSON.stringify({ v: PROTOCOL, type: 'opened', id }))
    console.error(`[mock-phone] opened #${id} -> ${msg.host}:${msg.port} (local ${local})`)
  })
  socket.on('data', chunk => {
    for (let off = 0; off < chunk.length; off += 64 * 1024) {
      ws.send(encodeBinaryFrame(id, chunk.subarray(off, off + 64 * 1024)), { binary: true })
    }
  })
  socket.on('close', () => {
    if (!streams.has(id)) return
    streams.delete(id)
    ws.send(JSON.stringify({ v: PROTOCOL, type: 'close', id, reason: 'eof' }))
  })
  socket.on('error', () => {
    clearTimeout(timer)
    if (streams.has(id)) {
      streams.delete(id)
      ws.send(JSON.stringify({ v: PROTOCOL, type: 'close', id, reason: 'error' }))
    } else {
      ws.send(JSON.stringify({ v: PROTOCOL, type: 'open_error', id, code: 'refused', message: 'connect failed' }))
    }
  })
})
ws.on('close', () => { console.error('[mock-phone] ws closed'); process.exit(0) })
ws.on('error', err => { console.error('[mock-phone]', err.message); process.exit(1) })

setInterval(() => {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify({ v: PROTOCOL, type: 'ping', t: Date.now() })) } catch {}
  }
}, 15_000).unref()
