import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('dataimpulse-proxy.sh never calls ci-proxy when the toggle is off', () => {
  const root = mkdtempSync(join(tmpdir(), 'px-off-')), work = join(root, 'w')
  const env = { ...process.env, PROXY_REQUEST: '' }
  const r = spawnSync('bash', [new URL('./dataimpulse-proxy.sh', import.meta.url).pathname, work, 'oc', root], { encoding: 'utf8', env })
  assert.equal(r.status, 5)
  assert.deepEqual(JSON.parse(readFileSync(join(work, 'status.json'), 'utf8')), { result: 'proxy_off' })
  rmSync(root, { recursive: true, force: true })
})

test('lazy-proxy-setup.sh skips DataImpulse when the toggle is off', () => {
  const root = mkdtempSync(join(tmpdir(), 'lazy-off-')), scripts = join(root, 'scripts'), web = join(root, 'web')
  for (const d of [scripts, web]) mkdirSync(d)
  copyFileSync(new URL('./lazy-proxy-setup.sh', import.meta.url), join(scripts, 'lazy-proxy-setup.sh'))
  writeFileSync(join(scripts, 'warp-proxy.sh'), 'echo failed')
  writeFileSync(join(scripts, 'dataimpulse-proxy.sh'), `touch "${root}/called"; mkdir -p "$1"; echo http://127.0.0.1:9 > "$1/proxy-url"; exit 0`)
  writeFileSync(join(scripts, 'start-opencode-serve.sh'), 'exit 0')
  const run = proxy => spawnSync('bash', [join(scripts, 'lazy-proxy-setup.sh')], { encoding: 'utf8', env: { ...process.env, OPENCODE_BIN: 'oc', OPENCODE_WEB_DIR: web, RUNNER_TEMP: root, PROXY_REQUEST: proxy } })
  assert.equal(run('false').status, 1)
  assert.equal(existsSync(join(root, 'called')), false)
  assert.equal(JSON.parse(readFileSync(join(web, 'warp-status.json'), 'utf8')).lazy, 'none')
  assert.equal(run('true').status, 3, 'on: current behaviour (DataImpulse after WARP fails)')
  assert.equal(existsSync(join(root, 'called')), true)
  rmSync(root, { recursive: true, force: true })
})
