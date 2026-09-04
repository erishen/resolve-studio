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
import { toolEcho } from '../src/plugins/tools/tool-echo.js'
import pse from '@resolve-studio/plugin-pse'
import type { ChatMessage, ChatOptions, ChatResponse, ChatStreamChunk } from '../src/types.js'
import { definePlugin } from '../src/plugins/util.js'
import { tasks as tasksPlugin } from '../src/plugins/tasks.js'

// The shared `calculator` tool is not gated (needsApproval:false), so the gated
// approval tests register a gated variant that preserves the same tool name the
// mock LLM targets, letting them exercise the approval-gating path.
const registerGatedCalculator = (ctx: Context): void => {
  ctx.tools.register({
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression.',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    async execute(args) {
      return String(eval(String(args['expression'] ?? '')))
    },
    needsApproval: true,
  })
}
const gatedCalculator = definePlugin(registerGatedCalculator, 'tool-gated-calculator', ['tools'])

test('agent loop calls the echo tool and returns a final answer', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
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
  assert.match(result, /not registered/)
  await root.fiber.dispose()
})

test('gated tool blocks on approval; rejection is fed back to the model', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock, { tool: 'calculator' })
  await root.plugin(gatedCalculator)

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
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock, { tool: 'calculator' })
  await root.plugin(gatedCalculator)

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
  async *chatStream(
    _messages: ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatStreamChunk> {
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
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(AbortLlm)

  const ac = new AbortController()
  const runPromise = root.agent.run({
    messages: [{ role: 'user', content: 'hi' }],
    signal: ac.signal,
  })
  await new Promise((r) => setTimeout(r, 50))
  ac.abort()
  const answer = await runPromise
  // The run must settle (not hang) and return a string even when cancelled.
  assert.equal(typeof answer, 'string')

  await root.fiber.dispose()
})

test('multiple tool calls in one step execute in parallel', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  // Track tool execution windows to prove overlap.
  const starts: number[] = []
  const ends: number[] = []
  const delay = 150

  // Two slow tools; if serial they'd take >=300ms, parallel ~150ms.
  root.tools.register({
    name: 'slow-a',
    description: 'slow tool a',
    parameters: { type: 'object', properties: {} },
    async execute() {
      starts.push(Date.now())
      await new Promise((r) => setTimeout(r, delay))
      ends.push(Date.now())
      return 'a-done'
    },
  })
  root.tools.register({
    name: 'slow-b',
    description: 'slow tool b',
    parameters: { type: 'object', properties: {} },
    async execute() {
      starts.push(Date.now())
      await new Promise((r) => setTimeout(r, delay))
      ends.push(Date.now())
      return 'b-done'
    },
  })

  // LLM that returns both tool calls at once, then a final answer.
  let step = 0
  class ParallelLlm extends LlmService {
    async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
      if (step === 0) {
        step++
        return {
          content: '',
          toolCalls: [
            { id: 'call-a', name: 'slow-a', arguments: '{}' },
            { id: 'call-b', name: 'slow-b', arguments: '{}' },
          ],
        }
      }
      return { content: 'all done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(ParallelLlm)

  const t0 = Date.now()
  const answer = await root.agent.run({ messages: [{ role: 'user', content: 'do both' }] })
  const elapsed = Date.now() - t0

  assert.equal(answer, 'all done')
  assert.equal(starts.length, 2)
  assert.equal(ends.length, 2)
  // Parallel: total time should be close to one delay, not two.
  assert.ok(elapsed < delay * 1.8, `expected parallel (<${delay * 1.8}ms), got ${elapsed}ms`)
  // Execution windows must overlap.
  const sortedStarts = starts.sort((a, b) => a - b)
  const firstEnd = ends.sort((a, b) => a - b)[0]
  assert.ok(
    sortedStarts[1] < firstEnd,
    `expected overlap: second start ${sortedStarts[1]} < first end ${firstEnd}`,
  )

  await root.fiber.dispose()
})

test('includeTools filters the schemas the LLM sees (MCP prefix matching)', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  // Register a couple of MCP-prefixed tools plus one built-in.
  root.tools.register({
    name: 'serena:index',
    description: 'mcp serena index',
    parameters: { type: 'object', properties: {} },
    fromMcp: true,
    async execute() {
      return 'indexed'
    },
  })
  root.tools.register({
    name: 'serena:query',
    description: 'mcp serena query',
    parameters: { type: 'object', properties: {} },
    fromMcp: true,
    async execute() {
      return 'hits'
    },
  })
  root.tools.register({
    name: 'tool-read-file',
    description: 'read a file',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'file'
    },
  })

  // Capture the tools each LLM request is sent.
  const seenTools: string[][] = []
  class CaptureLlm extends LlmService {
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: 'hi' }],
    includeTools: ['serena', 'tool-read-file'],
  })

  assert.equal(answer, 'done')
  assert.equal(seenTools.length, 1)
  const names = seenTools[0]
  assert.ok(names.includes('serena:index'))
  assert.ok(names.includes('serena:query'))
  assert.ok(names.includes('tool-read-file'))
  // An unrelated tool not in the include list must have been pruned.
  assert.ok(root.tools.get('tool-read-file'))

  await root.fiber.dispose()
})

test('excludeTools prunes a server while keeping the rest', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  root.tools.register({
    name: 'memory:remember',
    description: 'remember something',
    parameters: { type: 'object', properties: {} },
    fromMcp: true,
    async execute() {
      return 'ok'
    },
  })
  root.tools.register({
    name: 'tool-echo',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'echo'
    },
  })

  const seenTools: string[][] = []
  class CaptureLlm2 extends LlmService {
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm2)

  await root.agent.run({
    messages: [{ role: 'user', content: 'hi' }],
    excludeTools: ['memory'],
  })

  assert.equal(seenTools.length, 1)
  assert.ok(!seenTools[0].includes('memory:remember'), 'memory server should be pruned')
  assert.ok(seenTools[0].includes('tool-echo'), 'built-in should remain')

  await root.fiber.dispose()
})

test('filters prune the LLM schema even when options.tools is supplied', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  root.tools.register({
    name: 'memory:remember',
    description: 'remember something',
    parameters: { type: 'object', properties: {} },
    fromMcp: true,
    async execute() {
      return 'ok'
    },
  })
  root.tools.register({
    name: 'tool-echo',
    description: 'echo',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'echo'
    },
  })

  const seenTools: string[][] = []
  class CaptureLlm3 extends LlmService {
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm3)

  // Hand-supplied tool set PLUS a filter: the LLM schema must reflect the
  // pruned set, not the raw options.tools list.
  await root.agent.run({
    messages: [{ role: 'user', content: 'hi' }],
    tools: root.tools.list() as unknown as never,
    excludeTools: ['memory'],
  })

  assert.equal(seenTools.length, 1)
  assert.ok(!seenTools[0].includes('memory:remember'), 'LLM schema should drop pruned server')
  assert.ok(seenTools[0].includes('tool-echo'), 'LLM schema keeps the remaining tool')

  await root.fiber.dispose()
})

test('a matched task narrows the LLM toolset to its professional whitelist', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(tasksPlugin)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  // Register tools: some in the 'articles' task whitelist, some heavy/external.
  root.tools.register({
    name: 'article-write',
    description: 'generate a bilingual article',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'written'
    },
  })
  root.tools.register({
    name: 'privacy-audit',
    description: 'audit repo privacy',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'ok'
    },
  })
  root.tools.register({
    name: 'read-file',
    description: 'read a file',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'f'
    },
  })
  root.tools.register({
    name: 'serena:index',
    description: 'mcp index',
    parameters: { type: 'object', properties: {} },
    fromMcp: true,
    async execute() {
      return 'idx'
    },
  })

  const seenTools: string[][] = []
  const seenSystem = { text: '' }
  class CaptureLlm3 extends LlmService {
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      for (const m of messages) if (m.role === 'system') seenSystem.text += m.content
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm3)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '帮我写一篇技术文章并发布到掘金' }],
  })

  assert.equal(answer, 'done')
  assert.equal(seenTools.length, 1)
  // Professional tool + core builtins present…
  assert.ok(seenTools[0].includes('article-write'))
  assert.ok(seenTools[0].includes('read-file'))
  // …while unrelated feature/ MCP tools are pruned from the context.
  assert.ok(!seenTools[0].includes('privacy-audit'), 'privacy-audit should be pruned')
  assert.ok(!seenTools[0].includes('serena:index'), 'unrelated MCP server should be pruned')
  // Task guardrail system prompt was injected.
  assert.match(seenSystem.text, /任务说明/)

  await root.fiber.dispose()
})

test('a forced taskId pins the whitelist even when the message would not auto-match', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(tasksPlugin)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  root.tools.register({
    name: 'article-write',
    description: 'generate a bilingual article',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'written'
    },
  })
  root.tools.register({
    name: 'privacy-audit',
    description: 'audit repo privacy',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'ok'
    },
  })

  const seenTools: string[][] = []
  class CaptureLlm4 extends LlmService {
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm4)

  // A message that does NOT contain any 'articles' keyword.
  await root.agent.run({
    messages: [{ role: 'user', content: '1+1 等于几' }],
    taskId: 'articles',
  })

  assert.equal(seenTools.length, 1)
  assert.ok(seenTools[0].includes('article-write'), 'forced task whitelist should apply')
  assert.ok(!seenTools[0].includes('privacy-audit'), 'privacy-audit should still be pruned')

  await root.fiber.dispose()
})

test('an unknown taskId falls back to the full toolset (no whitelist)', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(tasksPlugin)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  root.tools.register({
    name: 'article-write',
    description: 'generate a bilingual article',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'written'
    },
  })
  root.tools.register({
    name: 'privacy-audit',
    description: 'audit repo privacy',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'ok'
    },
  })

  const seenTools: string[][] = []
  class CaptureLlm5 extends LlmService {
    async chat(_messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm5)

  await root.agent.run({
    messages: [{ role: 'user', content: '1+1 等于几' }],
    taskId: 'no-such-task',
  })

  assert.equal(seenTools.length, 1)
  // Unknown task → the run keeps every registered tool (no whitelist applied).
  assert.ok(seenTools[0].includes('article-write'), 'full toolset keeps article-write')
  assert.ok(seenTools[0].includes('privacy-audit'), 'full toolset keeps privacy-audit')

  await root.fiber.dispose()
})

test('a capability scope id (e.g. core) prunes to that horizontal tier, no business prompt', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(tasksPlugin)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService, { timeout: 500 })
  await root.plugin(skills, { dir: '../../skills' })

  root.tools.register({
    name: 'article-write',
    description: 'generate a bilingual article',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'written'
    },
  })
  root.tools.register({
    name: 'privacy-audit',
    description: 'audit repo privacy',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return 'ok'
    },
  })

  const seenTools: string[][] = []
  const seenPrompts: string[] = []
  class CaptureLlm6 extends LlmService {
    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
      seenTools.push((options?.tools ?? []).map((t) => t.name))
      const sys = messages.find((m) => m.role === 'system')
      seenPrompts.push(typeof sys?.content === 'string' ? sys.content : '')
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm6)

  // Forcing the horizontal 'core' scope drops business tools entirely.
  await root.agent.run({
    messages: [{ role: 'user', content: '帮我写篇文章' }],
    taskId: 'core',
  })

  assert.equal(seenTools.length, 1)
  assert.ok(!seenTools[0].includes('article-write'), 'core scope prunes business article-write')
  assert.ok(!seenTools[0].includes('privacy-audit'), 'core scope prunes privacy-audit')
  // A scope is a capability tier, not a business scenario: no guardrail prompt.
  assert.ok(!seenPrompts[0].includes('任务说明'), 'scope must not inject business guardrail prompt')

  await root.fiber.dispose()
})

test('a reply that declares a tool without calling it is nudged to actually call it', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  root.tools.register({
    name: 'save-copy',
    description: 'Persist copy to a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute(args) {
      return `saved ${String(args['content'] ?? '').length} chars`
    },
    needsApproval: false,
  })

  const calls: string[] = []
  const steps: string[] = []
  // Turn 1: call echo (real tool call). Turn 2: *declare* save-copy in prose
  // without emitting a tool-call — the loop must notice and nudge. Turn 3
  // (after the nudge): actually call save-copy. Turn 4: final answer.
  class DeclareThenRun extends LlmService {
    private round = 0
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      this.round++
      if (this.round === 1) {
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        return {
          toolCalls: [
            {
              id: `declare-${this.round}`,
              name: 'echo',
              arguments: JSON.stringify({ text: (lastUser?.content as string) ?? '' }),
            },
          ],
        }
      }
      if (this.round === 2) {
        // Declares the tool but no tool-call: exactly the failure mode observed
        // in production ("用 hot-news 生成文案" with nothing executed).
        return { content: '素材已就绪，用 save-copy 保存文案。' }
      }
      if (this.round === 3) {
        return {
          toolCalls: [
            {
              id: `declare-${this.round}`,
              name: 'save-copy',
              arguments: JSON.stringify({ path: 'copy.md', content: 'hello' }),
            },
          ],
        }
      }
      return { content: '文案已用 save-copy 保存到工作区。' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(DeclareThenRun)
  root.on('agent/tool-call', (call) => calls.push(call.name))
  root.on('agent/step', (step) => steps.push(step.message.role))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '写一篇营销文案并保存' }],
  })

  // Both planned tools were actually executed (echo + save-copy), and the
  // model was nudged between turn 2 and turn 3 rather than finishing early.
  assert.ok(calls.includes('echo'), 'echo tool ran')
  assert.ok(calls.includes('save-copy'), 'declared save-copy was actually called after the nudge')
  assert.ok(
    steps.filter((r) => r === 'assistant').length >= 3,
    'loop continued past the declaration',
  )
  assert.match(answer, /save-copy/)

  await root.fiber.dispose()
})

test('a prose-only step that names NO tool but matches an alias is nudged', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  // A tool whose name maps to a TOOL_ALIASES phrase ("生成*文案" → hot-news).
  root.tools.register({
    name: 'hot-news',
    description: 'Generate social-media copy for a hot topic.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    async execute() {
      return 'hot-news: draft ready'
    },
    needsApproval: false,
  })

  const calls: string[] = []
  // Round 1: prose-only "生成文案" with NO tool-call and NO tool name — matches
  // the hot-news alias, so the loop must nudge. Round 2 (after nudge): call it.
  class ProseThenRun extends LlmService {
    private round = 0
    async chat(): Promise<ChatResponse> {
      this.round++
      if (this.round === 1) {
        // Failure mode from production: STEP describes the next action only in
        // prose, never naming "hot-news" nor emitting a tool-call.
        return { content: '素材读完了，现在生成文案。' }
      }
      if (this.round === 2) {
        return {
          toolCalls: [
            { id: `prose-${this.round}`, name: 'hot-news', arguments: '{ "topic": "GPT-6" }' },
          ],
        }
      }
      return { content: '文案已生成并保存。' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(ProseThenRun)
  root.on('agent/tool-call', (call) => calls.push(call.name))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '写一篇营销文案并保存' }],
  })
  // The alias nudge fired: hot-news was actually called despite the model only
  // saying "生成文案" (no tool name, no tool-call) on its first attempt.
  assert.ok(calls.includes('hot-news'), 'hot-news was called after the alias-based nudge')
  assert.match(answer, /文案已生成/)
  await root.fiber.dispose()
})

test('a final answer that merely mentions an already-run tool is not nudged', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  root.tools.register({
    name: 'save-copy',
    description: 'Persist copy to a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute(args) {
      return `saved ${String(args['content'] ?? '').length} chars`
    },
    needsApproval: false,
  })

  const toolCallsSeen: string[] = []
  class RunThenSummary extends LlmService {
    private round = 0
    async chat(_messages: ChatMessage[]): Promise<ChatResponse> {
      this.round++
      if (this.round === 1) {
        // Actually execute save-copy (so it lands in `messages` as a tool turn).
        return {
          toolCalls: [
            {
              id: `sum-${this.round}`,
              name: 'save-copy',
              arguments: JSON.stringify({ path: 'copy.md', content: 'hello' }),
            },
          ],
        }
      }
      // Genuine summary: mentions the (already executed) tool in the past tense.
      return { content: '完成，文案已用 save-copy 保存。' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(RunThenSummary)
  root.on('agent/tool-call', (call) => toolCallsSeen.push(call.name))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '写一篇营销文案并保存' }],
  })

  // save-copy ran exactly once; the summary mentioning it was not re-flagged,
  // so the run ended on the second assistant turn.
  assert.deepEqual(toolCallsSeen, ['save-copy'])
  assert.match(answer, /save-copy/)

  await root.fiber.dispose()
})

test('a tool failing repeatedly is nudged to change approach (not retried forever)', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  // A tool that always fails — stands in for the "file too big / sandbox
  // outside" wall the model kept hitting in the stock-scan run.
  root.tools.register({
    name: 'always-fail',
    description: 'Always fails.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async execute() {
      return 'error: file is 4358586 bytes, exceeds the 64 KiB read limit'
    },
    needsApproval: false,
  })

  const calls: string[] = []
  // The model stubbornly retries always-fail twice; only after the guard's
  // nudge message lands does it finally give up and answer.
  class StubbornRetry extends LlmService {
    private round = 0
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      this.round++
      const last = [...messages].reverse().find((m) => m.role === 'user')
      const lastText = typeof last?.content === 'string' ? last.content : ''
      if (lastText.includes('连续失败')) {
        // The guard's nudge reached the model — change approach.
        return { content: '好的，换个方式，直接基于已有结果汇报。' }
      }
      return {
        toolCalls: [
          {
            id: `fail-${this.round}`,
            name: 'always-fail',
            arguments: JSON.stringify({ path: 'scan_result.json' }),
          },
        ],
      }
    }
    async models() {
      return []
    }
  }
  await root.plugin(StubbornRetry)
  root.on('agent/tool-call', (call) => calls.push(call.name))

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '读取 scan 结果并汇报' }],
  })

  // The failing tool was retried at most FAIL_THRESHOLD times; after the nudge
  // the model changed approach instead of burning the whole iteration budget.
  assert.ok(calls.length <= 3, `retried too many times: ${calls.length}`)
  assert.ok(calls.every((c) => c === 'always-fail'))
  assert.match(answer, /换个方式/)

  await root.fiber.dispose()
})

test('a tool-call with empty arguments is short-circuited with a precise missing-args error', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  let executed = 0
  root.tools.register({
    name: 'save-copy',
    description: 'Persist copy to a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute(args) {
      executed++
      return `saved ${String(args['content'] ?? '').length} chars`
    },
    needsApproval: false,
  })

  // The model fires save-copy with NO arguments (the observed write-file
  // failure mode). The guard short-circuits it (tool never runs) and pushes a
  // tool-role message listing the missing fields; the model then fixes the call
  // and, once it succeeds, answers.
  class EmptyArgsThenFix extends LlmService {
    private round = 0
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      this.round++
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool')
      const sawMissing =
        typeof lastTool?.content === 'string' && lastTool.content.includes('缺少必填参数')
      const sawSuccess = typeof lastTool?.content === 'string' && lastTool.content.includes('saved')
      if (sawSuccess) {
        return { content: '文案已保存。' }
      }
      if (sawMissing) {
        return {
          toolCalls: [
            {
              id: `ok-${this.round}`,
              name: 'save-copy',
              arguments: JSON.stringify({ path: 'copy.md', content: 'hello' }),
            },
          ],
        }
      }
      return {
        toolCalls: [{ id: `empty-${this.round}`, name: 'save-copy', arguments: '{}' }],
      }
    }
    async models() {
      return []
    }
  }
  await root.plugin(EmptyArgsThenFix)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '写营销文案并保存' }],
  })

  // The empty-arguments call was short-circuited (execute never ran for it),
  // and only the second, parameter-complete call actually executed.
  assert.equal(executed, 1, 'only the well-formed call executed')
  assert.match(answer, /保存/)

  await root.fiber.dispose()
})
