import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
test('bound Ubuntu mirror stalls before every Playwright apt invocation', () => {
  const script = readFileSync(new URL('./setup-linux-playwright.sh', import.meta.url), 'utf8')
  assert.ok(script.indexOf('/etc/apt/apt.conf.d/80omgithub-network') < script.indexOf('apt-get update'))
  for (const option of ['ForceIPv4 "true"', 'Retries "1"', 'http::Timeout "20"', 'https::Timeout "20"']) assert.ok(script.includes(option))
  assert.match(script, /timeout --kill-after=10s 180s sudo -n apt-get update/)
  const workflow = readFileSync(new URL('../.github/workflows/opencode-reusable.yml', import.meta.url), 'utf8')
  assert.match(workflow, /Configure Linux Playwright CLI with WebGPU\n        timeout-minutes: 8/)
})
