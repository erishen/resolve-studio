/**
 * Offline smoke test: the full agent loop with the mock LLM + echo tool,
 * composed entirely through Cordis (no network, no API key).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { AgentService } from '../src/services/agent.js'
import { FastPathService } from '../src/services/fastpath.js'
import { ApprovalService } from '../src/services/approval.js'
import { LlmService } from '../src/services/llm.js'
import { skills } from '../src/plugins/skills.js'
import { llmMock } from '../src/plugins/llm-mock.js'
import { toolEcho } from '../src/plugins/tool-echo.js'
import { toolCalculator } from '../src/plugins/tool-calculator.js'
import type { ChatMessage, ChatOptions, ChatResponse, ChatStreamChunk } from '../src/types.js'

test('agent loop calls the echo tool and returns a final answer', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock)
  await root.plugin(toolEcho)

  assert.equal(root.tools.get('echo')?.name, 'echo')

  const steps: string[] = []
  root.on('agent/step', (step) => steps.push(step.message.role))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: 'please echo hello world' }],
  })

  assert.match(answer, /hello world/)
  // user -> assistant(tool_call) -> tool -> assistant(answer) => 2 assistant steps
  assert.equal(steps.filter((r) => r === 'assistant').length, 2)
  assert.ok(root.tools.schemas().some((t) => t.name === 'echo'))

  await root.fiber.dispose()
})

test('unknown tool returns an error string without throwing', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  const result = await root.tools.call('nope', '{}')
  assert.match(result, /unknown tool/)
  await root.fiber.dispose()
})

test('gated tool blocks on approval; rejection is fed back to the model', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock, { tool: 'calculator' })
  await root.plugin(toolCalculator)

  const requested: { id: string; name: string }[] = []
  const toolResults: { ok: boolean }[] = []
  root.on('agent/approval-request', (call) => requested.push(call))
  root.on('agent/tool-result', (p) => toolResults.push(p))

  const runPromise = root.agent.run({ messages: [{ role: 'user', content: 'compute 2+2' }] })
  // The approval-request is emitted synchronously once the loop hits the gated
  // tool; give the microtasks a beat, then reject.
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(requested.length, 1)
  assert.equal(requested[0].name, 'calculator')

  const ok = root.approval.resolve(requested[0].id, 'reject')
  assert.ok(ok)

  const answer = await runPromise
  assert.match(answer, /Mock LLM received/)
  // The rejection was fed back as an ok:false tool result.
  assert.equal(toolResults.length, 1)
  assert.equal(toolResults[0].ok, false)

  await root.fiber.dispose()
})

test('runId namespaces approval call ids to avoid cross-run collisions', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock, { tool: 'calculator' })
  await root.plugin(toolCalculator)

  const requested: string[] = []
  root.on('agent/approval-request', (call) => requested.push(call.id))

  const runId = 'run-abc'
  const runPromise = root.agent.run({ messages: [{ role: 'user', content: 'compute 2+2' }], runId })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(requested.length, 1)
  assert.ok(requested[0].startsWith(runId + ':'), `expected namespaced id, got ${requested[0]}`)

  // The namespaced id is what the UI must send back to resolve.
  const ok = root.approval.resolve(requested[0], 'reject')
  assert.ok(ok)
  const answer = await runPromise
  assert.match(answer, /Mock LLM received/)

  await root.fiber.dispose()
})

// A minimal LLM whose stream yields one delta, then waits for an abort (or a
// short timeout) before yielding the rest — so we can exercise mid-stream
// cancellation.
class AbortLlm extends LlmService {
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    return { content: 'final' }
  }
  async *chatStream(_messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk> {
    const signal = options?.signal
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    yield { content: 'partial' }
    const aborted = await new Promise<boolean>((resolve) => {
      if (!signal) return resolve(false)
      if (signal.aborted) return resolve(true)
      signal.addEventListener('abort', () => resolve(true))
      setTimeout(() => resolve(false), 300)
    })
    if (aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    yield { content: ' done' }
  }
  async models() {
    return []
  }
}

test('aborting a run resolves without hanging', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(AbortLlm)

  const ac = new AbortController()
  const runPromise = root.agent.run({ messages: [{ role: 'user', content: 'hi' }], signal: ac.signal })
  await new Promise((r) => setTimeout(r, 50))
  ac.abort()
  const answer = await runPromise
  // The run must settle (not hang) and return a string even when cancelled.
  assert.equal(typeof answer, 'string')

  await root.fiber.dispose()
})
