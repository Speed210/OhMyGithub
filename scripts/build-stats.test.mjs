import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStats } from './build-stats.mjs'
import { attemptErrorClass } from './run-with-model-fallback.mjs'
import { failurePayload } from './run-failure.mjs'

test('build stats read WARP status, current and final model, capped attempts and duration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-'))
  assert.deepEqual(buildStats(dir), {})
  writeFileSync(join(dir, 'warp-status.json'), JSON.stringify({ decision: 'on', result: '429_fallback', attempt: 6, egress_prefix: '2606:4700:110::/48', colo: 'IAD' }))
  writeFileSync(join(dir, 'main-model'), 'opencode/glm-5.3-flash-free\n')
  const attempts = Array.from({ length: 10 }, (_, i) => ({ model: `opencode/m${i}`, cli_code: 1, outcome: 'failed', code: 1, retryable: true, error_class: 'free-limit', duration_ms: i }))
  attempts.push({ model: 'opencode/glm-5.3-flash-free', cli_code: 0, outcome: 'succeeded', code: 0, retryable: false, error_class: null, duration_ms: 5 })
  writeFileSync(join(dir, 'model-attempts.json'), JSON.stringify(attempts))
  writeFileSync(join(dir, 'build-started-at'), '1000')
  const stats = buildStats(dir, 61000)
  assert.deepEqual(stats.warp, { decision: 'on', result: '429_fallback', attempt: 6, egress_prefix: '2606:4700:110::/48', colo: 'IAD' })
  assert.equal(stats.model, 'opencode/glm-5.3-flash-free')
  assert.equal(stats.final_model, 'opencode/glm-5.3-flash-free')
  assert.equal(stats.attempts.length, 8)
  assert.equal(stats.attempts[0].error_class, 'free-limit')
  assert.equal(stats.attempts.at(-1).error_class, undefined)
  assert.equal(stats.duration_ms, 60000)
  assert.equal(stats.opencode_ms, 50) // sum of every attempt, not the capped 8
  const payload = failurePayload({ GITHUB_RUN_ID: '9', OPENCODE_WEB_DIR: dir }, 5)
  assert.equal(payload.outcome, 'failure'); assert.equal(payload.final_model, 'opencode/glm-5.3-flash-free')
})

test('attempt error classes', () => {
  assert.equal(attemptErrorClass(undefined), null)
  assert.equal(attemptErrorClass({ type: 'provider.free-limit' }), 'free-limit')
  assert.equal(attemptErrorClass({ message: 'FreeUsageLimit reached' }), 'free-limit')
  assert.equal(attemptErrorClass({ status: 429 }), 'rate-limit')
  assert.equal(attemptErrorClass({ status: 401 }), 'auth')
  assert.equal(attemptErrorClass({ message: 'Game build failed' }), 'other')
})

test('build stats carry the DataImpulse result, /64 and relay byte total', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-'))
  writeFileSync(join(dir, 'warp-status.json'), JSON.stringify({ decision: 'on', result: 'proxy_ok', attempt: 2, egress_prefix64: '2a09:bac5:1:2::/64', warp_result: '429_fallback' }))
  writeFileSync(join(dir, 'proxy-bytes.json'), JSON.stringify({ up: 100, down: 900, tunnels: 2, failed: 0 }))
  assert.deepEqual(buildStats(dir).warp, { decision: 'on', result: 'proxy_ok', attempt: 2, egress_prefix64: '2a09:bac5:1:2::/64', warp_result: '429_fallback', proxy_bytes: 1000 })
})
