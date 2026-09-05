import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitContext, fitContextWithSummary, estimateChars } from '../src/context.js'
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

test('fitContext (summarizeDropped) lists dropped tool activity in the note', () => {
  const sys = msg('system', 'you are helpful')
  // An assistant message that issued a tool call, which will be dropped.
  const dropped = {
    role: 'assistant',
    content: 'let me check',
    toolCalls: [{ id: 'c1', name: 'read-file', arguments: '{}' }],
  } as unknown as ChatMessage
  const many: ChatMessage[] = []
  for (let i = 0; i < 60; i++) many.push(msg('user', `message number ${i} ` + 'x'.repeat(60)))
  const msgs = [sys, dropped, ...many]

  const out = fitContext(msgs, { maxChars: 2000, summarizeDropped: true })

  const note = out.find((m) => typeof m.content === 'string' && m.content.includes('omitted'))
  assert.ok(note, 'an omit note should be present')
  assert.match(String(note?.content), /read-file/, 'note should mention the dropped tool')
})

test('fitContextWithSummary replaces the omit note with an LLM summary', async () => {
  const sys = msg('system', 'you are helpful')
  const many: ChatMessage[] = []
  for (let i = 0; i < 60; i++) many.push(msg('user', `message number ${i} ` + 'x'.repeat(60)))
  const msgs = [sys, ...many]

  let summarized: ChatMessage[] | null = null
  const out = await fitContextWithSummary(msgs, {
    maxChars: 2000,
    summarize: async (dropped) => {
      summarized = dropped
      return '用户早期询问了若干问题（内容已省略）。'
    },
  })

  assert.ok(summarized && summarized.length > 0, 'the dropped region was handed to the summarizer')
  const note = out.find((m) => typeof m.content === 'string' && m.content.includes('摘要'))
  assert.ok(note, 'the LLM summary replaced the terse note')
  assert.match(String(note?.content), /用户早期询问/)
  assert.equal(out[0].content, 'you are helpful', 'system message stays first')
  assert.equal(out[out.length - 1].content, many[many.length - 1].content, 'tail survives')
  assert.ok(estimateChars(out) <= 2000)
})

test('fitContextWithSummary falls back to the omit note when summarize fails', async () => {
  const sys = msg('system', 'you are helpful')
  const many: ChatMessage[] = []
  for (let i = 0; i < 60; i++) many.push(msg('user', `message number ${i} ` + 'x'.repeat(60)))
  const msgs = [sys, ...many]

  const out = await fitContextWithSummary(msgs, {
    maxChars: 2000,
    summarize: async () => {
      throw new Error('llm down')
    },
  })

  const note = out.find((m) => typeof m.content === 'string' && m.content.includes('omitted'))
  assert.ok(note, 'fallback omit note used when the summarizer throws')
  assert.ok(estimateChars(out) <= 2000)
})

test('fitContext keeps ALL leading system messages (instructions are never dropped)', () => {
  // env brief + skills index + caller system prompt all ride at the front.
  const sysMsgs = [
    msg('system', 'caller instruction topmost'),
    msg('system', 'skills index'),
    msg('system', 'environment briefing'),
  ]
  const many: ChatMessage[] = []
  for (let i = 0; i < 80; i++) many.push(msg('user', `content ${i}` + 'y'.repeat(60)))
  const out = fitContext([...sysMsgs, ...many], { maxChars: 2000 })

  const leading = out.filter((m) => m.role === 'system').slice(0, 3)
  assert.equal(leading[0]?.content, 'caller instruction topmost')
  assert.equal(leading[1]?.content, 'skills index')
  assert.equal(leading[2]?.content, 'environment briefing')
  assert.ok(estimateChars(out) <= 2000)
})

test('fitContext trims whole rounds: an assistant tool-call round is never split from its results', () => {
  const sys = msg('system', 'sys')
  const many: ChatMessage[] = []
  for (let i = 0; i < 40; i++) many.push(msg('user', `Q${i}` + 'z'.repeat(60)))
  // An assistant round that issued tools, at the front (oldest) — will be dropped whole.
  const droppedAssistant = {
    role: 'assistant',
    content: 'let me run it',
    toolCalls: [{ id: 'c1', name: 'shell', arguments: '{}' }],
  } as unknown as ChatMessage
  // A recent assistant round with tool results (must be kept together).
  const keptAssistant = {
    role: 'assistant',
    content: 'final check',
    toolCalls: [{ id: 'c2', name: 'read-file', arguments: '{}' }],
  } as unknown as ChatMessage
  const keptTool = msg('tool', 'file contents...')
  // Force KeptTool to reference keptAssistant's call id.
  ;(keptTool as { tool_call_id?: string }).tool_call_id = 'c2'

  const all = [sys, droppedAssistant, ...many, keptAssistant, keptTool]
  const out = fitContext(all, { maxChars: 3000 })

  // The kept assistant + its tool result are either both present or the tail
  // preserved. Since the tail starts at a round boundary, we never see the
  // tool message without its issuing assistant.
  const hasAssistant2 = out.some(
    (m) => (m as ChatMessage & { toolCalls?: unknown[] }).toolCalls?.length === 1,
  )
  const toolIdx = out.findIndex((m) => m.role === 'tool' && m.content === 'file contents...')
  if (toolIdx >= 0) {
    assert.ok(hasAssistant2, 'a kept tool result must keep its issuing assistant round')
  }
  assert.ok(estimateChars(out) <= 3000)
})

test('fitContext never drops the last user round (conversation must keep a user query)', () => {
  const sys = msg('system', 'sys')
  const many: ChatMessage[] = []
  // A long tool session: an old user question followed by many assistant+tool
  // rounds, all of which dwarf the budget. Compaction must still leave the
  // LAST user message in the output (OpenAI-compat endpoints 400 without one).
  for (let i = 0; i < 40; i++) {
    many.push(msg('user', `question ${i}`))
    many.push(msg('assistant', `answer ${i}` + 'y'.repeat(80)))
    const t = msg('tool', 'tool result ' + 'z'.repeat(80))
    ;(t as { tool_call_id?: string }).tool_call_id = `call-${i}`
    many.push(t)
  }

  const out = fitContext([sys, ...many], { maxChars: 1200 })
  const userCount = out.filter((m) => m.role === 'user').length
  assert.ok(userCount >= 1, `expected ≥1 user message after compaction, got ${userCount}`)
  const lastUserContent = [...out].reverse().find((m) => m.role === 'user')?.content
  const originalLastUser = [...many].reverse().find((m) => m.role === 'user')?.content
  assert.equal(lastUserContent, originalLastUser, 'the most recent user query survives')
})
