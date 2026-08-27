import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { UsageService } from '../src/services/usage.js'

test('UsageService records and tallies tokens + cost', async () => {
  const root = new Context()
  await root.plugin(UsageService)

  const records: unknown[] = []
  root.on('llm/usage', (r) => records.push(r))

  // gpt-4o-mini is free in the default price table.
  root.usage.record('gpt-4o-mini', 1000, 500)
  // deepseek-chat: in 0.002 / out 0.008 per 1K tokens.
  root.usage.record('deepseek-chat', 2000, 1000)

  const snap = root.usage.snapshot()
  assert.equal(snap.totalPromptTokens, 3000)
  assert.equal(snap.totalCompletionTokens, 1500)
  assert.equal(snap.totalTokens, 4500)
  assert.equal(snap.requests, 2)
  // gpt-4o-mini => 0.00225 (1000*0.00075/1000 + 500*0.003/1000); deepseek => 2000/1000*0.002 + 1000/1000*0.008 = 0.012
  assert.ok(Math.abs(snap.totalCost - 0.01425) < 1e-9)
  assert.equal(records.length, 2)
  assert.equal((records[0] as { model: string }).model, 'gpt-4o-mini')
})

test('UsageService tracks per-model breakdown and resets', async () => {
  const root = new Context()
  await root.plugin(UsageService)
  root.usage.record('gpt-4o-mini', 100, 50)
  root.usage.record('gpt-4o-mini', 100, 50)
  assert.equal(root.usage.snapshot().byModel['gpt-4o-mini'].requests, 2)
  root.usage.reset()
  assert.equal(root.usage.snapshot().requests, 0)
})

test('UsageService isolates totals per session while keeping global aggregate', async () => {
  const root = new Context()
  await root.plugin(UsageService)

  root.usage.record('deepseek-chat', 1000, 500, undefined, 'sess-a')
  root.usage.record('deepseek-chat', 2000, 1000, undefined, 'sess-b')
  root.usage.record('deepseek-chat', 300, 200) // no session → global only

  // Global includes all three records.
  const global = root.usage.snapshot()
  assert.equal(global.totalPromptTokens, 3300)
  assert.equal(global.totalCompletionTokens, 1700)
  assert.equal(global.requests, 3)

  // Per-session snapshots are isolated.
  const a = root.usage.snapshot('sess-a')
  assert.equal(a.totalPromptTokens, 1000)
  assert.equal(a.totalCompletionTokens, 500)
  assert.equal(a.requests, 1)

  const b = root.usage.snapshot('sess-b')
  assert.equal(b.totalPromptTokens, 2000)
  assert.equal(b.totalCompletionTokens, 1000)
  assert.equal(b.requests, 1)

  // Unknown session returns zeroed snapshot, not undefined.
  const missing = root.usage.snapshot('does-not-exist')
  assert.equal(missing.requests, 0)
  assert.equal(missing.totalTokens, 0)

  // Resetting one session does not affect the other or global.
  root.usage.reset('sess-a')
  assert.equal(root.usage.snapshot('sess-a').requests, 0)
  assert.equal(root.usage.snapshot('sess-b').requests, 1)
  assert.equal(root.usage.snapshot().requests, 3) // global unchanged

  // Resetting global clears everything including per-session.
  root.usage.reset()
  assert.equal(root.usage.snapshot().requests, 0)
  assert.equal(root.usage.snapshot('sess-b').requests, 0)
})
