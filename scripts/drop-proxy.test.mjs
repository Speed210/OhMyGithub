import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function run({ current, fallback, lastError }) {
  const root = mkdtempSync(join(tmpdir(), 'drop-proxy-')), scripts = join(root, 'scripts'), web = join(root, 'web')
  mkdirSync(scripts); mkdirSync(web)
  copyFileSync(new URL('./drop-proxy.sh', import.meta.url), join(scripts, 'drop-proxy.sh'))
  writeFileSync(join(scripts, 'start-opencode-serve.sh'), 'echo "$1" > "$OPENCODE_WEB_DIR/serve-call"')
  writeFileSync(join(web, 'opencode-proxy'), current + '\n')
  if (fallback) writeFileSync(join(web, 'opencode-proxy.fallback'), fallback + '\n')
  writeFileSync(join(web, 'proxy-bytes.json'), JSON.stringify({ up: 1, down: 1, last_error: lastError }))
  writeFileSync(join(web, 'warp-status.json'), JSON.stringify({ decision: 'on', result: 'proxy_ok' }))
  const r = spawnSync('bash', [join(scripts, 'drop-proxy.sh')], { encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: 'oc', OPENCODE_WEB_DIR: web } })
  const out = { code: r.status, serve: readFileSync(join(web, 'serve-call'), 'utf8').trim(), warp: JSON.parse(readFileSync(join(web, 'warp-status.json'), 'utf8')), fallbackLeft: existsSync(join(web, 'opencode-proxy.fallback')) }
  rmSync(root, { recursive: true, force: true })
  return out
}
test('dead DataImpulse at startup: back to the runner network, traffic_exhausted recorded', () => {
  assert.deepEqual(run({ current: 'http://127.0.0.1:9', lastError: '407 TRAFFIC_EXHAUSTED' }), { code: 0, serve: '', warp: { decision: 'on', result: 'proxy_ok', proxy_drop: 'traffic_exhausted' }, fallbackLeft: false })
})
test('dead DataImpulse after a runtime switch: back to the WARP relay', () => {
  const r = run({ current: 'http://127.0.0.1:9', fallback: 'http://127.0.0.1:7', lastError: '502 Bad Gateway' })
  assert.equal(r.serve, 'http://127.0.0.1:7')
  assert.equal(r.warp.proxy_drop, 'tunnel_error')
})
