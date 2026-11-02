import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { awaitingReply, endsWithQuestion } from './awaiting-reply.mjs'
const user = (id, t) => ({ id, type: 'user', time: { created: t } })
const assistant = (id, t, { files = [], text, tools = [] } = {}) => ({ id, type: 'assistant', time: { created: t }, snapshot: { files }, content: [...tools.map(([name, status]) => ({ type: 'tool', name, state: { status } })), ...(text ? [{ type: 'text', text }] : [])] })

test('detect a clarifying question that made no game files (issue #45 shape)', () => {
  const messages = [user('u1', 1), assistant('a1', 2, { tools: [['read', 'completed']] }), assistant('a2', 3, { text: '- Design the parry system?\n- Something else?\n\nWhat specifically would you like me to help you create or develop?' }), { type: 'idle', time: { created: 4 } }]
  assert.deepEqual({ ...awaitingReply(messages), question: undefined }, { awaiting: true, reason: 'text', message_id: 'a2', question: undefined })
  assert.equal(awaitingReply([...messages].reverse()).awaiting, true) // newest-first projections
})
test('do not wait when the turn changed files or ended without a question', () => {
  assert.equal(awaitingReply([user('u', 1), assistant('a', 2, { files: ['index.html'] }), assistant('b', 3, { text: 'Want any changes?' })]).awaiting, false)
  assert.equal(awaitingReply([user('u', 1), assistant('a', 2, { tools: [['write', 'completed']], text: 'Should I add sound?' })]).awaiting, false)
  assert.equal(awaitingReply([user('u', 1), assistant('a', 2, { text: 'Built the game.' })]).awaiting, false)
  assert.equal(awaitingReply([user('u', 1)]).awaiting, false)
  // Only the latest turn counts: an earlier question was answered by a later build.
  assert.equal(awaitingReply([user('u', 1), assistant('a', 2, { text: 'Which genre?' }), user('u2', 3), assistant('b', 4, { files: ['index.html'], text: 'Done.' })]).awaiting, false)
})
test('detect pending question or permission tools and markdown-wrapped questions', () => {
  assert.equal(awaitingReply([user('u', 1), assistant('a', 2, { tools: [['question', 'running']] })]).reason, 'question')
  assert.equal(awaitingReply([user('u', 1), assistant('a', 2, { tools: [['permission', 'pending']] })]).awaiting, true)
  assert.equal(endsWithQuestion('**What style do you want?**'), true)
  assert.equal(endsWithQuestion('Should I use Three.js?)'), true)
  assert.equal(endsWithQuestion('Is this ok? I built it anyway.'), false)
})
