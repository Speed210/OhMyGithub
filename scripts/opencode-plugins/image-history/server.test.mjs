import test from 'node:test'
import assert from 'node:assert/strict'
import plugin, { pruneImages, stripProxyEnv, NOTE } from './server.js'

class Message { constructor(v) { Object.assign(this, v) } }
const img = n => ({ type: 'media', media: { mediaType: 'image/jpeg', n } })
const file = n => ({ type: 'file', mime: 'image/png', uri: `data:image/png;base64,${n}` })
const tool = (...value) => ({ type: 'tool-result', id: 't', name: 'read', result: { type: 'content', value } })

test('keeps the newest two images across user media and tool results', () => {
  const messages = [
    new Message({ role: 'user', content: [{ type: 'text', text: 'hi' }, img(1)] }),
    new Message({ role: 'tool', content: [tool({ type: 'text', text: 'x' }, file(2))] }),
    new Message({ role: 'tool', content: [tool(file(3))] }),
    new Message({ role: 'user', content: [img(4)] }),
  ]
  assert.equal(pruneImages(messages, 2), 2)
  assert.deepEqual(messages[0].content[1], { type: 'text', text: NOTE })
  assert.deepEqual(messages[1].content[0].result.value, [{ type: 'text', text: 'x' }, { type: 'text', text: NOTE }])
  assert.equal(messages[2].content[0].result.value[0].uri, 'data:image/png;base64,3')
  assert.equal(messages[3].content[0].media.n, 4)
  assert.ok(messages[0] instanceof Message)
})

test('is stable until a new image arrives', () => {
  const messages = [new Message({ role: 'user', content: [img(1)] }), new Message({ role: 'user', content: [img(2)] })]
  assert.equal(pruneImages(messages, 2), 0)
  const first = messages[0]
  assert.equal(pruneImages(messages, 2), 0)
  assert.equal(messages[0], first)
  messages.push(new Message({ role: 'user', content: [img(3)] }))
  assert.equal(pruneImages(messages, 2), 1)
  assert.equal(pruneImages(messages, 2), 0)
})

test('ignores non-image files', () => {
  const messages = [new Message({ role: 'tool', content: [tool({ type: 'file', mime: 'text/plain', uri: 'x' })] })]
  for (let i = 0; i < 3; i++) messages.push(new Message({ role: 'user', content: [img(i)] }))
  assert.equal(pruneImages(messages, 2), 1)
  assert.equal(messages[0].content[0].result.value[0].mime, 'text/plain')
})

test('strips proxy variables in both cases and keeps the rest', () => {
  const env = { HTTPS_PROXY: 'a', http_proxy: 'b', ALL_PROXY: 'c', all_proxy: 'd', HTTP_PROXY: 'e', https_proxy: 'f', NO_PROXY: 'g', PATH: '/bin' }
  assert.deepEqual(stripProxyEnv(env), { NO_PROXY: 'g', PATH: '/bin' })
})

test('setup registers both hooks', async () => {
  const hooks = {}
  await plugin.setup({ session: { hook: async (n, f) => { hooks['session.' + n] = f } }, shell: { hook: async (n, f) => { hooks['shell.' + n] = f } } })
  assert.deepEqual(Object.keys(hooks).sort(), ['session.context', 'shell.create.before'])
  const event = { env: { HTTPS_PROXY: 'x', TERM: 'xterm' } }
  hooks['shell.create.before'](event)
  assert.deepEqual(event.env, { TERM: 'xterm' })
})
