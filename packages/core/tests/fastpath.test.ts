/**
 * Fast Path tests: pure arithmetic short-circuits the LLM loop (zero model
 * calls, zero events); non-arithmetic input falls through to the loop.
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

test('pure arithmetic resolves via Fast Path without any agent step', async () => {
  const root = await buildContext()
  const steps: unknown[] = []
  root.on('agent/step', (s) => steps.push(s))

  const answer = await root.agent.run({ messages: [{ role: 'user', content: '3+4' }] })

  assert.match(answer, /Fast Path resolved: 7/)
  assert.equal(steps.length, 0, 'no LLM loop steps for pure arithmetic')

  await root.fiber.dispose()
})

test('non-arithmetic input falls through to the normal agent loop', async () => {
  const root = await buildContext()
  const steps: unknown[] = []
  root.on('agent/step', (s) => steps.push(s))

  const answer = await root.agent.run({ messages: [{ role: 'user', content: 'hello fastpath' }] })

  assert.match(answer, /Mock LLM received/)
  assert.ok(steps.length > 0, 'expected LLM loop steps')

  await root.fiber.dispose()
})
