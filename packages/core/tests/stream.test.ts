/**
 * Streaming tests: delta events, tool-call merging, and the mock's
 * character-by-character stream all through the real agent loop.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { AgentService } from '../src/services/agent.js'
import { FastPathService } from '../src/services/fastpath.js'
import { ApprovalService } from '../src/services/approval.js'
import { skills } from '../src/plugins/skills.js'
import { llmMock } from '../src/plugins/llm-mock.js'
import { toolEcho } from '../src/plugins/tools/tool-echo.js'

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock)
  await root.plugin(toolEcho)
  return root
}

test('delta events concatenate into the final answer (typewriter stream)', async () => {
  const root = await buildContext()
  const deltas: string[] = []
  root.on('agent/delta', (t) => deltas.push(t))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: 'hello streaming' }],
  })

  const joined = deltas.join('')
  assert.ok(joined.length > 0, 'expected at least one delta')
  assert.equal(joined, answer, 'deltas must reconstruct the exact answer')

  await root.fiber.dispose()
})

test('streaming tool-call fragments are merged and executed', async () => {
  const root = await buildContext()
  const steps: { toolCalls: { name: string }[] }[] = []
  root.on('agent/step', (s) => steps.push(s))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: 'please echo xyz' }],
  })

  assert.match(answer, /xyz/)
  const toolStep = steps.find((s) => s.toolCalls.length > 0)
  assert.ok(toolStep, 'expected a step with tool calls')
  assert.equal(toolStep.toolCalls[0].name, 'echo')

  await root.fiber.dispose()
})

test('reasoning deltas are forwarded when the adapter emits them', async () => {
  const root = await buildContext()
  const reasoning: string[] = []
  root.on('agent/reasoning', (t) => reasoning.push(t))

  await root.agent.run({ messages: [{ role: 'user', content: 'hello reasoning' }] })

  // The mock emits a fake thinking block before calling the tool and again
  // before the final answer.
  assert.ok(reasoning.length >= 2, 'expected reasoning deltas')

  await root.fiber.dispose()
})
