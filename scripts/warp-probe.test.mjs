import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const source = readFileSync(new URL('./warp-proxy.sh', import.meta.url), 'utf8')
const probeModel = source.slice(source.indexOf('probe_model() {'), source.indexOf('\n}\n', source.indexOf('probe_model() {')) + 3)

// Runs the real probe_model against a fake opencode that replies from a scripted list.
function probe(replies) {
  const directory = mkdtempSync(join(tmpdir(), 'warp-probe-')), bin = join(directory, 'oc')
  writeFileSync(join(directory, 'replies.json'), JSON.stringify(replies))
  writeFileSync(bin, `#!/usr/bin/env node
const fs=require('fs'),f=${JSON.stringify(join(directory, 'n'))};const n=fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0;fs.writeFileSync(f,String(n+1))
const r=JSON.parse(fs.readFileSync(${JSON.stringify(join(directory, 'replies.json'))},'utf8'))[n]||'ok'
console.log(r==='ok'?'{"type":"text","part":{"text":"OK"}}':r==='429'?'{"type":"error","error":{"name":"FreeUsageLimit"}}':r==='gone'?'{"type":"error","error":{"name":"ModelDeprecated"}}':'{"type":"error","error":{"name":"Boom"}}')`, { mode: 0o755 })
  const script = `set -uo pipefail\nwork=${JSON.stringify(directory)}; opencode_bin=${JSON.stringify(bin)}; PROBE_SECONDS=5\nPROBE_MODELS=(m/a m/b)\nlog() { :; }\nbounded() { shift; "$@"; }\n${probeModel}\nprobe_model http://127.0.0.1:1; echo "rc=$?"`
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  const calls = +readFileSync(join(directory, 'n'), 'utf8')
  rmSync(directory, { recursive: true, force: true })
  return { rc: Number(result.stdout.match(/rc=(\d+)/)?.[1]), calls }
}

test('WARP probe needs two answers in a row before trusting the exit', () => {
  assert.deepEqual(probe(['ok', 'ok']), { rc: 0, calls: 2 })
  assert.deepEqual(probe(['ok', '429']), { rc: 4, calls: 2 }, 'second request rate limited: not usable')
  assert.deepEqual(probe(['429']), { rc: 4, calls: 1 })
  assert.deepEqual(probe(['ok', 'boom']), { rc: 2, calls: 2 })
  assert.deepEqual(probe(['gone', 'ok', 'ok']), { rc: 0, calls: 3 }, 'unavailable model advances to the next')
  assert.deepEqual(probe(['gone', 'gone']), { rc: 3, calls: 2 })
})
