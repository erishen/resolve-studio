import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { UsageService } from '../src/services/usage.js'

test('UsageService records and tallies tokens + cost', async () => {
  const root = new Context()
  await root.plugin(UsageService)

  const records: unknown[] = []
  root.on('llm/usage', (r) => records.push(r))

  // agnes-2.0-flash is free in the default price table.
  root.usage.record('agnes-2.0-flash', 1000, 500)
  // deepseek-chat: in 0.002 / out 0.008 per 1K tokens.
  root.usage.record('deepseek-chat', 2000, 1000)

  const snap = root.usage.snapshot()
  assert.equal(snap.totalPromptTokens, 3000)
  assert.equal(snap.totalCompletionTokens, 1500)
  assert.equal(snap.totalTokens, 4500)
  assert.equal(snap.requests, 2)
  // agnes free => 0; deepseek => 2000/1000*0.002 + 1000/1000*0.008 = 0.012
  assert.ok(Math.abs(snap.totalCost - 0.012) < 1e-9)
  assert.equal(records.length, 2)
  assert.equal((records[0] as { model: string }).model, 'agnes-2.0-flash')
})

test('UsageService tracks per-model breakdown and resets', async () => {
  const root = new Context()
  await root.plugin(UsageService)
  root.usage.record('agnes-2.0-flash', 100, 50)
  root.usage.record('agnes-2.0-flash', 100, 50)
  assert.equal(root.usage.snapshot().byModel['agnes-2.0-flash'].requests, 2)
  root.usage.reset()
  assert.equal(root.usage.snapshot().requests, 0)
})
