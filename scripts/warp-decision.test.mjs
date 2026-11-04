import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { warpDecision, labelNames } from './warp-decision.mjs'

test('WARP is skipped only for Default when Fusion is on', () => {
  assert.equal(warpDecision({ requested: true, fusionEnabled: true, labels: ['OpenCode', 'warp'] }), 'skip')
  assert.equal(warpDecision({ requested: true, fusionEnabled: false, labels: ['OpenCode', 'warp'] }), 'on')
  assert.equal(warpDecision({ requested: true, fusionEnabled: true, labels: ['OpenCode', 'warp', 'model/opencode/beam-free'] }), 'on')
  assert.equal(warpDecision({ requested: true, fusionEnabled: false, labels: ['warp', 'model/opencode/beam-free'] }), 'on')
  assert.equal(warpDecision({ requested: false, fusionEnabled: false, labels: ['OpenCode'] }), 'off')
})

test('CLI reads the workflow labels_json (strings or label objects)', () => {
  const run = (...args) => execFileSync(process.execPath, [new URL('./warp-decision.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' }).trim()
  assert.equal(run('true', 'true', '["OpenCode","warp"]'), 'skip')
  assert.equal(run('true', 'false', '["OpenCode","warp"]'), 'on')
  assert.equal(run('true', 'true', '[{"name":"warp"},{"name":"model/opencode/beam-free"}]'), 'on')
  assert.equal(run('false', 'true', '[]'), 'off')
  assert.deepEqual(labelNames('not json'), [])
})

test('the workflow asks warp-decision before starting the WARP proxy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  const decide = workflow.indexOf('scripts/warp-decision.mjs')
  assert.ok(decide > workflow.indexOf('FUSION_PLUGIN_COMMIT=%s'), 'decision comes after Fusion is resolved')
  assert.ok(decide < workflow.indexOf('scripts/warp-proxy.sh'), 'decision gates the WARP proxy')
  assert.match(workflow, /WARP_DECISION" == 'on'/)
})
