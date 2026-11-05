// Local CONNECT relay to an authenticated upstream HTTP proxy (DataImpulse).
// OpenCode only ever sees http://127.0.0.1:PORT, so the upstream login and
// password never reach its env, its logs or opencode.log. Counts tunneled
// bytes for cost tracking (numbers only, no hosts or credentials).
//
// Usage: node proxy-relay.mjs <creds-file> <port-file> <bytes-file>
// creds-file: JSON {host, port, user, password}; read once, then deleted.
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

export function createRelay({ host, port, user, password, connectUpstream = connect }) {
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64')
  const totals = { up: 0, down: 0, tunnels: 0, failed: 0 }
  const server = createServer((req, res) => { res.writeHead(405, { connection: 'close' }); res.end() })
  server.on('connect', (req, client, head) => {
    const target = String(req.url || '')
    if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(target)) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    const upstream = connectUpstream({ host, port })
    let buffered = Buffer.alloc(0), open = false
    const fail = () => { totals.failed++; if (!open) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); else client.destroy(); upstream.destroy() }
    upstream.setTimeout(30000, () => { if (!open) fail() })
    upstream.on('error', fail)
    client.on('error', () => upstream.destroy())
    upstream.on('connect', () => upstream.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`))
    const onHeader = chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) { if (buffered.length > 16384) fail(); return }
      upstream.off('data', onHeader)
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString('latin1'))?.[1])
      if (status !== 200) { totals.failed++; client.end(`HTTP/1.1 ${status === 407 ? 502 : status || 502} Upstream Proxy Error\r\n\r\n`); upstream.destroy(); return }
      open = true; totals.tunnels++; upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const rest = buffered.subarray(end + 4)
      if (rest.length) { totals.down += rest.length; client.write(rest) }
      if (head?.length) { totals.up += head.length; upstream.write(head) }
      upstream.on('data', data => { totals.down += data.length })
      client.on('data', data => { totals.up += data.length })
      upstream.pipe(client); client.pipe(upstream)
    }
    upstream.on('data', onHeader)
  })
  return { server, totals }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [credsFile, portFile, bytesFile] = process.argv.slice(2)
  const creds = JSON.parse(readFileSync(credsFile, 'utf8'))
  rmSync(credsFile, { force: true })
  const { server, totals } = createRelay(creds)
  const save = () => { try { writeFileSync(bytesFile, JSON.stringify({ up: totals.up, down: totals.down, tunnels: totals.tunnels, failed: totals.failed })) } catch {} }
  setInterval(save, 15000).unref()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { save(); process.exit(0) })
  server.listen(0, '127.0.0.1', () => { writeFileSync(portFile, String(server.address().port)); save() })
}
