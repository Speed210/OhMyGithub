import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { createRelay } from './proxy-relay.mjs'

test('relay adds upstream proxy auth, tunnels, counts bytes, and keeps creds off the client side', async () => {
  const target = createServer((req, res) => res.end('hello'))
  target.listen(0, '127.0.0.1'); await once(target, 'listening')
  const seen = []
  const upstream = createServer()
  upstream.on('connect', (req, socket) => {
    seen.push(req.headers['proxy-authorization'])
    if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('u__sessid.1:p').toString('base64')) return socket.end('HTTP/1.1 407 Auth\r\n\r\n')
    const [host, port] = req.url.split(':')
    const out = connect(Number(port), host, () => { socket.write('HTTP/1.1 200 OK\r\n\r\n'); out.pipe(socket); socket.pipe(out) })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const { server, totals } = createRelay({ host: '127.0.0.1', port: upstream.address().port, user: 'u__sessid.1', password: 'p' })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const tunnel = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, method: 'CONNECT', path: `127.0.0.1:${target.address().port}` })
    req.on('connect', (res, socket) => resolve({ res, socket })); req.on('error', reject); req.end()
  })
  assert.equal(tunnel.res.statusCode, 200)
  tunnel.socket.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
  let body = ''; tunnel.socket.on('data', d => { body += d })
  await once(tunnel.socket, 'end')
  assert.match(body, /hello/)
  assert.doesNotMatch(body, /Basic|sessid/)
  assert.equal(seen.length, 1)
  assert.ok(totals.up > 0 && totals.down > 0 && totals.tunnels === 1)
  // Plain HTTP requests are refused; bad upstream auth surfaces as 502, not 407.
  const plain = await new Promise(resolve => request({ host: '127.0.0.1', port: server.address().port, path: 'http://example.com/' }, resolve).end())
  assert.equal(plain.statusCode, 405)
  const bad = createRelay({ host: '127.0.0.1', port: upstream.address().port, user: 'x', password: 'y' })
  bad.server.listen(0, '127.0.0.1'); await once(bad.server, 'listening')
  const denied = await new Promise(resolve => { const r = request({ host: '127.0.0.1', port: bad.server.address().port, method: 'CONNECT', path: 'a.b:443' }); r.on('connect', res => resolve(res.statusCode)); r.end() })
  assert.equal(denied, 502)
  for (const s of [target, upstream, server, bad.server]) s.close()
})
