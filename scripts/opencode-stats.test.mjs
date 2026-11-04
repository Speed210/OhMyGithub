import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectSessionStats, finishStats, messageStats, emptyStats } from './opencode-stats.mjs'
import { reportSessionStats } from './run-with-model-fallback.mjs'
import { buildStats } from './build-stats.mjs'

const messages = [
  { type: 'idle', outcome: 'succeeded' },
  { id: 'msg_2', type: 'assistant', tokens: { input: 100, output: 50, reasoning: 50, cache: { read: 1000, write: 10 } }, time: { created: 1, streamed: 1000, completed: 3000 },
    parts: [{ type: 'tool', tool: 'read', state: { input: { filePath: 'a.png' }, attachments: [{ mime: 'image/png' }] } }, { type: 'tool', tool: 'edit', state: { input: { filePath: 'src/a.js' } } }, { type: 'tool', tool: 'edit', input: { filePath: 'src/a.js' } }, { type: 'text', text: 'SECRET PROMPT' }] },
  { id: 'msg_1', type: 'user', text: 'make a game' },
  { type: 'assistant', tokens: { input: 'x', output: null } }, null
]

test('message stats sum tokens, speed, tools, images and unique changed files; numbers only', () => {
  const s = finishStats(messageStats(messages))
  assert.equal(s.model_tokens, 1210); assert.equal(s.tokens_cache_read, 1000)
  assert.equal(s.output_tokens_per_second, 50)
  assert.equal(s.tool_calls, 3); assert.deepEqual(s.tools, { edit: 2, read: 1 })
  assert.equal(s.image_calls, 1); assert.equal(s.changed_files, 1); assert.equal(s.messages, 3)
  assert.ok(!JSON.stringify(s).includes('SECRET') && !JSON.stringify(s).includes('src/a.js'))
  assert.equal(finishStats(emptyStats()).output_tokens_per_second, undefined)
})

test('subagents are counted, failures detected, and their tokens included', async () => {
  const api = { messages: async id => id === 'ses_main' ? messages : id === 'ses_bad' ? [{ type: 'idle', outcome: 'failed' }, { type: 'assistant', tokens: { output: 5 } }] : [{ type: 'assistant', tokens: { input: 7 } }],
    children: async () => [{ id: 'ses_ok' }, { id: 'ses_bad' }, {}] }
  const s = finishStats(await collectSessionStats(api, 'ses_main'))
  assert.equal(s.total_subagents, 2); assert.equal(s.failed_subagents, 1); assert.equal(s.model_tokens, 1222)
  const broken = { messages: async () => messages, children: async () => { throw new Error('404') } }
  assert.equal(finishStats(await collectSessionStats(broken, 'ses_main')).total_subagents, 0)
})

test('reportSessionStats saves stats, posts /telemetry and feeds build stats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocs-'))
  const posts = []
  const api = { messages: async () => messages, children: async () => [] }
  const env = { OMGITHUB_CALLBACK_TOKEN: 'cb', GITHUB_REPOSITORY: 'me/game', TRIGGER_ISSUE_NUMBER: '4', GITHUB_RUN_ID: '99', OMGITHUB_ORIGIN: 'https://x.test' }
  const stats = await reportSessionStats({ api, sessionID: 'ses_main', directory: dir, env, attempts: [{ duration_ms: 61000 }], request: async (url, init) => { posts.push([url, JSON.parse(init.body)]) } })
  assert.equal(stats.chat_runtime_seconds, 61)
  assert.equal(posts[0][0], 'https://x.test/api/github/me/game/issues/4/telemetry')
  assert.deepEqual(Object.keys(posts[0][1]).sort(), ['attempt', 'observed_at', 'run', 'stats'])
  assert.equal(JSON.parse(readFileSync(join(dir, 'opencode-stats.json'), 'utf8')).tool_calls, 3)
  assert.equal(buildStats(dir).opencode_stats.model_tokens, 1210)
  assert.equal(await reportSessionStats({ api: { messages: async () => { throw new Error('down') } }, sessionID: 'ses_x', directory: dir, env: {} }), null)
  assert.equal(await reportSessionStats({ api, sessionID: '', directory: dir }), null)
})
