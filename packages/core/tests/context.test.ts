import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitContext, estimateChars } from '../src/context.js'
import type { ChatMessage } from '../src/types.js'

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content }
}

test('fitContext returns the conversation unchanged when within budget', () => {
  const msgs = [msg('system', 'sys'), msg('user', 'hi'), msg('assistant', 'hello')]
  const out = fitContext(msgs, { maxChars: 10_000 })
  assert.deepEqual(out, msgs)
  assert.equal(out[0].content, 'sys')
})

test('fitContext trims old messages and inserts a system note when over budget', () => {
  const sys = msg('system', 'you are helpful')
  const many: ChatMessage[] = []
  for (let i = 0; i < 60; i++) many.push(msg('user', `message number ${i} ` + 'x'.repeat(60)))
  const msgs = [sys, ...many]

  const out = fitContext(msgs, { maxChars: 2000 })

  // Leading system message is preserved verbatim.
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, 'you are helpful')
  // A system note marks the omitted region.
  assert.ok(out.some((m) => typeof m.content === 'string' && m.content.includes('omitted')))
  // The result is back within budget.
  assert.ok(estimateChars(out) <= 2000)
  // The most recent message survives (contiguous tail).
  assert.equal(out[out.length - 1].content, many[many.length - 1].content)
})
