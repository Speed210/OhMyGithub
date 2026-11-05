import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Real runtime-proxy-switch.sh next to stub dataimpulse/serve scripts.
function run(dataimpulse, serveOk = true, proxy = 'true') {
  const root = mkdtempSync(join(tmpdir(), 'rt-switch-')), scripts = join(root, 'scripts'), web = join(root, 'web'), temp = join(root, 'tmp')
  for (const d of [scripts, web, temp]) mkdirSync(d)
  copyFileSync(new URL('./runtime-proxy-switch.sh', import.meta.url), join(scripts, 'runtime-proxy-switch.sh'))
  writeFileSync(join(scripts, 'dataimpulse-proxy.sh'), `mkdir -p "$1"; echo '::add-mask::s3cret'; echo '{"result":"${dataimpulse}"}' > "$1/status.json"
[ ${dataimpulse} = proxy_ok ] && echo http://127.0.0.1:9 > "$1/proxy-url"; [ ${dataimpulse} = proxy_ok ] && exit 0; [ ${dataimpulse} = proxy_429 ] && exit 4; exit 2`)
  writeFileSync(join(scripts, 'start-opencode-serve.sh'), `echo "$1" >> "$OPENCODE_WEB_DIR/serve-calls"; [ -z "$1" ] || [ "$1" = http://127.0.0.1:7 ] || exit ${serveOk ? 0 : 1}`)
  writeFileSync(join(web, 'warp-status.json'), JSON.stringify({ decision: 'on', result: 'ok', attempt: 1 }))
  writeFileSync(join(web, 'opencode-proxy'), 'http://127.0.0.1:7\n')
  const result = spawnSync('bash', [join(scripts, 'runtime-proxy-switch.sh')], { encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: 'oc', OPENCODE_WEB_DIR: web, RUNNER_TEMP: temp, PROXY_REQUEST: proxy } })
  const out = { code: result.status, stdout: result.stdout, warp: JSON.parse(readFileSync(join(web, 'warp-status.json'), 'utf8')), serve: existsSync(join(web, 'serve-calls')) ? readFileSync(join(web, 'serve-calls'), 'utf8').trim().split('\n') : [] }
  rmSync(root, { recursive: true, force: true })
  return out
}
test('runtime switch restarts serve on the relay and records proxy_ok at runtime', () => {
  const r = run('proxy_ok')
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '', 'mask lines never reach the caller')
  assert.deepEqual(r.serve, ['http://127.0.0.1:9'])
  assert.deepEqual(r.warp, { decision: 'on', result: 'ok', attempt: 1, proxy: 'proxy_ok', switched_at: 'runtime' })
})
test('runtime switch failures keep WARP serving and record the proxy result', () => {
  for (const result of ['proxy_429', 'proxy_error']) {
    const r = run(result)
    assert.notEqual(r.code, 0)
    assert.deepEqual(r.serve, [])
    assert.deepEqual(r.warp, { decision: 'on', result: 'ok', attempt: 1, proxy: result, switched_at: 'runtime' })
  }
  const r = run('proxy_ok', false)
  assert.notEqual(r.code, 0)
  assert.deepEqual(r.serve, ['http://127.0.0.1:9', 'http://127.0.0.1:7'], 'restores the previous WARP serve')
  assert.equal(r.warp.proxy, 'proxy_error')
})
test('runtime switch does nothing when the residential proxy toggle is off', () => {
  for (const proxy of ['', 'false']) {
    const r = run('proxy_ok', true, proxy)
    assert.notEqual(r.code, 0)
    assert.deepEqual(r.serve, [])
    assert.deepEqual(r.warp, { decision: 'on', result: 'ok', attempt: 1 })
  }
})
