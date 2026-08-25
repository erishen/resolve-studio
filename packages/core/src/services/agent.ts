/**
 * Agent service — the agent loop.
 *
 * Registered under `ctx.agent`. It drives the classic LLM ↔ tool loop:
 *
 *   1. ask `ctx.llm` for the next step (with the current tool schemas);
 *   2. if the model answers, emit `agent/done` and return;
 *   3. if the model requests tools, run each through `ctx.tools.call`,
 *      append the results, and go back to step 1.
 *
 * Every step emits `agent/step` so observers (the CLI, tests, a web UI, ...)
 * can stream progress without coupling to the loop internals.
 */

import { Context, Service } from 'cordis'
import type {
  AgentRunOptions,
  AgentStep,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamChunk,
  RunEventBus,
  ToolCall,
} from '../types.js'
import type { ApprovalDecision } from './approval.js'
import { fitContext } from '../context.js'

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
  interface Events {
    'agent/step'(step: AgentStep): void
    'agent/tool-call'(call: ToolCall): void
    'agent/tool-result'(payload: { call: ToolCall; result: string; ok: boolean }): void
    'agent/delta'(text: string): void
    'agent/reasoning'(text: string): void
    'agent/done'(answer: string): void
  }
}

export class AgentService extends Service {
  // The agent loop reaches into the tool registry and the LLM backend, so it
  // must declare those as injected dependencies; otherwise Cordis' property
  // guard throws "cannot get property … without inject" when `run` touches
  // `this.ctx.tools` / `this.ctx.llm`.
  static inject = { tools: {}, llm: {}, fastpath: {}, approval: {}, skills: {} }

  constructor(ctx: Context) {
    super(ctx, 'agent')
  }

  /**
   * Run the agent loop for the given messages and return the final answer.
   *
   * The loop mutates a private copy of the conversation; the caller's array is
   * not touched. Emits `agent/step` per iteration and `agent/done` at the end.
   */
  async run(options: AgentRunOptions): Promise<string> {
    const maxIterations = options.maxIterations ?? 8
    const tools = options.tools ?? this.ctx.tools.schemas()
    // Per-run event sink: when the caller supplies one (the web bridge does,
    // once per HTTP request) every `agent/*` / `llm/*` event is scoped to that
    // run so concurrent chats don't cross-talk. Without it we fall back to the
    // global `ctx.events` bus, which keeps the CLI's `ctx.events.on(...)` and
    // the tests' observers working unchanged.
    const bus: RunEventBus = options.bus ?? ((this.ctx.events as unknown) as RunEventBus)
    // Bound the conversation to the context window before anything else.
    const messages: ChatMessage[] = fitContext(options.messages.map((m) => ({ ...m })), {
      maxChars: options.contextBudgetChars,
    })

    // Fast Path: if the last user message is a pure arithmetic query we can
    // resolve deterministically, short-circuit the whole LLM loop (zero model
    // calls). This mirrors resolve-harness' "never ask the model what code can
    // compute" principle.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser && this.ctx.fastpath && typeof lastUser.content === 'string') {
      const resolved = this.ctx.fastpath.tryResolve(lastUser.content)
      if (resolved !== null) {
        const answer = `Fast Path resolved: ${resolved}`
        this.ctx.logger('agent').info('fast path hit: "%s" → %s', lastUser.content, resolved)
        bus.emit('agent/done', answer)
        return answer
      }
    }

    // Skills: inject the index of available skills into a system message so
    // the model knows what workflows it can follow (it reads SKILL.md via the
    // read-file tool when it decides to use one).
    if (this.ctx.skills) {
      const skillsIndex = await this.ctx.skills.indexText()
      if (skillsIndex) messages.unshift({ role: 'system', content: skillsIndex })
    }

    const runId = options.runId

    for (let i = 0; i < maxIterations; i++) {
      // Allow an in-flight run to be cancelled between steps.
      if (options.signal?.aborted) {
        const partial = this.lastAnswer(messages)
        bus.emit('agent/done', partial)
        return partial
      }

      let response: ChatResponse
      try {
        response = await this.nextResponse(messages, {
          tools: tools.length ? tools : undefined,
          model: options.model,
          signal: options.signal,
          bus,
        })
      } catch (err) {
        // Aborted mid-stream: stop and return whatever we have so far.
        if (options.signal?.aborted || (err as Error)?.name === 'AbortError') {
          const partial = this.lastAnswer(messages)
          bus.emit('agent/done', partial)
          return partial
        }
        throw err
      }

      const assistant: ChatMessage = {
        role: 'assistant',
        content: response.content ?? '',
        ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
      }
      messages.push(assistant)

      const toolCalls = response.toolCalls ?? []
      const toolResults: { call: ToolCall; result: string; ok: boolean }[] = []

      if (toolCalls.length) {
        for (const call of toolCalls) {
          // Namespace the call id with the run id so two concurrent runs that
          // happen to get the same model-generated call id don't collide in
          // the approval registry. The original id is still used for the
          // tool-result message the LLM sees.
          const nsId = this.ns(call.id, runId)
          bus.emit('agent/tool-call', { ...call, id: nsId })

          // Human-in-the-loop: tools flagged `needsApproval` block here until
          // a human approves or rejects them (via ctx.approval — wired to the
          // web UI's /api/approval endpoint). A rejection is fed back to the
          // model as a tool result so it can adjust instead of crashing.
          const schema = tools.find((t) => t.name === call.name)
          if (schema?.needsApproval && this.ctx.approval) {
            const decision: ApprovalDecision = await this.ctx.approval.request({ ...call, id: nsId }, bus)
            if (decision === 'reject') {
              const result = `User rejected the tool call "${call.name}" (arguments: ${JSON.stringify(call.arguments)}). Do not call it again; explain or adjust.`
              const ok = false
              toolResults.push({ call, result, ok })
              bus.emit('agent/tool-result', { call: { ...call, id: nsId }, result, ok })
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.name,
                content: result,
              })
              continue
            }
          }

          const result = await this.ctx.tools.call(call.name, call.arguments)
          const ok = !result.startsWith('error:')
          toolResults.push({ call, result, ok })
          bus.emit('agent/tool-result', { call: { ...call, id: nsId }, result, ok })
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result,
          })
        }
      }

      const step: AgentStep = { message: assistant, toolCalls, toolResults }
      bus.emit('agent/step', step)

      if (!toolCalls.length) {
        // Trim leading/trailing whitespace: many LLM outputs start with a
        // blank line, which would otherwise leak into the UI as an empty line
        // at the top of the answer bubble.
        const answer = (response.content ?? '').trim()
        bus.emit('agent/done', answer)
        return answer
      }
    }

    const fallback = 'Reached the maximum number of iterations without a final answer.'
    this.ctx.logger('agent').warn(fallback)
    bus.emit('agent/done', fallback)
    return fallback
  }

  /**
   * Ask the LLM for the next step, preferring the streaming variant when the
   * adapter implements it. Text deltas are forwarded as `agent/delta` events
   * so UIs can render a typewriter effect; tool-call fragments are merged by
   * `index` into complete calls (OpenAI streaming shape).
   */
  private async nextResponse(
    messages: ChatMessage[],
    options: { tools?: AgentRunOptions['tools']; model?: string; signal?: AbortSignal; bus?: RunEventBus },
  ): Promise<ChatResponse> {
    const callOptions: ChatOptions = {
      tools: options.tools,
      model: options.model,
      signal: options.signal,
      bus: options.bus,
    }
    if (!this.ctx.llm.chatStream) return this.ctx.llm.chat(messages, callOptions)

    const bus = options.bus ?? ((this.ctx.events as unknown) as RunEventBus)
    const toolCalls: ToolCall[] = []
    let content = ''
    for await (const chunk of this.ctx.llm.chatStream(messages, callOptions)) {
      if (chunk.content) {
        content += chunk.content
        bus.emit('agent/delta', chunk.content)
      }
      if (chunk.reasoning) {
        bus.emit('agent/reasoning', chunk.reasoning)
      }
      if (chunk.toolCalls?.length) this.mergeToolCalls(toolCalls, chunk.toolCalls)
    }
    return {
      content: content || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    }
  }

  /** Namespace a tool call id with the run id (no-op when there's no run id). */
  private ns(callId: string, runId?: string): string {
    return runId ? `${runId}:${callId}` : callId
  }

  /** Best-effort answer recovered from a partially-run conversation. */
  private lastAnswer(messages: ChatMessage[]): string {
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    const text = last && typeof last.content === 'string' ? last.content.trim() : ''
    return text || 'Run stopped before a final answer was produced.'
  }

  private mergeToolCalls(target: ToolCall[], deltas: ChatStreamChunk['toolCalls']): void {
    for (const d of deltas ?? []) {
      let call = target[d.index]
      if (!call) {
        call = { id: d.id ?? `call-${d.index}`, name: d.name ?? '', arguments: '' }
        target[d.index] = call
      }
      if (d.id) call.id = d.id
      if (d.name) call.name = d.name
      const acc = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
      call.arguments = acc + (d.arguments ?? '')
    }
  }
}
