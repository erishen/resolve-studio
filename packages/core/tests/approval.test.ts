/**
 * Approval tests: manual rejection (already in agent.test.ts) plus the
 * timeout auto-reject path, proving the loop can never hang on a human.
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
import { toolCalculator } from '../src/plugins/tool-calculator.js'

test('pending approval times out and auto-rejects (loop never hangs)', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 150 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock, { tool: 'calculator' })
  await root.plugin(toolCalculator)

  const toolResults: { ok: boolean }[] = []
  root.on('agent/tool-result', (p) => toolResults.push(p))

  const started = Date.now()
  const answer = await root.agent.run({ messages: [{ role: 'user', content: 'please compute' }] })

  assert.ok(Date.now() - started >= 150, 'should have waited for the timeout')
  assert.equal(toolResults.length, 1)
  assert.equal(toolResults[0].ok, false, 'timeout must auto-reject')
  assert.match(answer, /Mock LLM received/, 'loop continues after auto-reject')

  await root.fiber.dispose()
})
