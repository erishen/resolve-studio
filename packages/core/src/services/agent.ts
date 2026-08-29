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

import type { Context } from 'cordis'
import { Service } from 'cordis'
// Load PSE plugin's type declarations so `ctx.pse` is typed.
import type {} from '@resolve-studio/plugin-pse'
import type {
  AgentRunOptions,
  AgentStep,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamChunk,
  RunEventBus,
  Tool,
  ToolCall,
} from '../types.js'
import type { ApprovalDecision } from './approval.js'
import { fitContext } from '../context.js'

/** Best-effort parse of tool arguments that arrive as a JSON string. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Canonical, deterministic string for a tool call's arguments — used to detect
 *  duplicate calls within a round. Strings are parsed to objects so the same
 *  args in either form compare equal; object keys are sorted. */
function canonicalArgs(args: string | Record<string, unknown>): string {
  let obj: unknown = args
  if (typeof args === 'string') {
    try {
      obj = JSON.parse(args)
    } catch {
      obj = args
    }
  }
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k])
          return acc
        }, {})
    }
    return v
  }
  return JSON.stringify(sort(obj))
}

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
  interface Events {
    'agent/step'(step: AgentStep): void
    'agent/tool-call'(call: ToolCall): void
    'agent/tool-result'(payload: {
      call: ToolCall
      result: string
      ok: boolean
      durationMs: number
    }): void
    'agent/delta'(text: string): void
    'agent/reasoning'(text: string): void
    'agent/done'(answer: string): void
  }
}

export interface AgentConfig {
  /** Default context-window budget in chars before old messages are trimmed.
   *  Overridable per-run via {@link AgentRunOptions.contextBudgetChars}. */
  contextBudgetChars?: number
}

export class AgentService extends Service {
  // The agent loop reaches into the tool registry and the LLM backend, so it
  // must declare those as injected dependencies; otherwise Cordis' property
  // guard throws "cannot get property … without inject" when `run` touches
  // `this.ctx.tools` / `this.ctx.llm`.
  static inject = { tools: {}, llm: {}, fastpath: {}, approval: {}, skills: {}, pse: {} }

  /** Per-plugin default context budget; a run may override it. */
  private readonly budgetChars?: number

  constructor(ctx: Context, config: AgentConfig = {}) {
    super(ctx, 'agent')
    this.budgetChars = config.contextBudgetChars
  }

  /**
   * Run the agent loop for the given messages and return the final answer.
   *
   * The loop mutates a private copy of the conversation; the caller's array is
   * not touched. Emits `agent/step` per iteration and `agent/done` at the end.
   */
  async run(options: AgentRunOptions): Promise<string> {
    // PSE three-role mode needs more iterations (Planner → Specialist → Evaluator
    // may each take multiple tool calls); bump the cap when PSE is active.
    const pseActive = this.ctx.pse?.enabled ?? false
    const maxIterations = options.maxIterations ?? (pseActive ? 15 : 8)
    const tools = options.tools ?? this.ctx.tools.schemas()
    // Index the full Tool definitions (incl. the dynamic `approvalWhen` rule)
    // by name for O(1) lookup in the loop. The LLM only sees the sanitized
    // `tools` schemas above; approval gating happens against the full Tool.
    const toolDefs: Tool[] = options.tools
      ? (options.tools as unknown as Tool[])
      : this.ctx.tools.list()
    const toolSchemaByName = new Map<string, Tool>(toolDefs.map((t) => [t.name, t]))
    // Per-run event sink: when the caller supplies one (the web bridge does,
    // once per HTTP request) every `agent/*` / `llm/*` event is scoped to that
    // run so concurrent chats don't cross-talk. Without it we fall back to the
    // global `ctx.events` bus, which keeps the CLI's `ctx.events.on(...)` and
    // the tests' observers working unchanged.
    const bus: RunEventBus = options.bus ?? (this.ctx.events as unknown as RunEventBus)
    // Bound the conversation to the context window before anything else. A
    // pre-budget (cheaper than the per-message cap in llm-openai.ts) plus a
    // rolling summary of dropped tool activity keeps long sessions coherent.
    const messages: ChatMessage[] = fitContext(
      options.messages.map((m) => ({ ...m })),
      {
        maxChars: options.contextBudgetChars ?? this.budgetChars,
        summarizeDropped: true,
      },
    )

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

    // Environment briefing: tell the model about the sandbox and file-writing
    // conventions so it doesn't waste a call on /home/user/ paths or miss the
    // task-level directory isolation.
    const envBrief = [
      '## 运行环境',
      '- 所有 shell 命令和文件写入都在沙箱中运行，无法写入工作目录和系统临时目录之外的位置。',
      '- write-file 工具：相对路径会自动写入 sandbox/<task>/ 目录，**直接写文件名即可，不要加 sandbox/ 前缀**。例如 path: "lru_cache.py" + task: "lru-cache" → 实际写入 sandbox/lru-cache/lru_cache.py。',
      '- 务必传入 task 参数（如 task: "lru-cache"）为每个任务创建独立子目录，不要直接写在 sandbox 根目录。',
      '- shell 命令中访问文件时，使用完整路径 sandbox/<task>/<filename>，或 cd 到该目录后运行。',
      '- 不要使用 /home/user/、/root/ 等绝对路径写入文件；读取文件可以用绝对路径。',
      '- shell 命令的工作目录是项目根目录，可正常运行 pnpm、node、python 等命令；如缺少依赖（如 pytest），用 python 直接运行脚本或先 pip install。',
      '- serena:* 工具需要先调用 serena:activate_project 激活项目；如果报 "No active project"，不要反复调用，改用内置的 read-file/write-file 工具。',
      '- 如果某个工具连续调用失败，换一种方式实现，不要反复重试消耗迭代次数。',
      '- 避免重复调用：同一个技能（skill-run）只加载一次；同一个工具如果已经在本轮对话中执行过且结果仍有效，不要再次调用。尤其：技能加载一次后直接按其中步骤执行，不要重复 skill-run；portfolio-check 体检一次通过后直接进入下一步，不要重复体检。',
    ].join('\n')
    messages.unshift({ role: 'system', content: envBrief })

    // Skills: inject the index of available skills into a system message so
    // the model knows what workflows it can follow (it reads SKILL.md via the
    // read-file tool when it decides to use one).
    if (this.ctx.skills) {
      const skillsIndex = await this.ctx.skills.indexText()
      if (skillsIndex) messages.unshift({ role: 'system', content: skillsIndex })
    }

    // PSE three-role mode: if enabled, inject the role discipline so the model
    // follows Planner → Specialist → Evaluator instead of a flat ReAct loop.
    if (this.ctx.pse?.enabled) {
      const psePrompt = await this.ctx.pse.systemPrompt()
      if (psePrompt) messages.unshift({ role: 'system', content: psePrompt })
    }

    // Caller-supplied system prompt (role preset / task instructions). Inserted
    // after the skills index so it takes precedence as the topmost instruction.
    if (options.systemPrompt) {
      messages.unshift({ role: 'system', content: options.systemPrompt })
    }

    const runId = options.runId

    // Loop detection: track recent assistant contents and tool-call counts so we
    // can bail early when the model is spinning (e.g. PSE mode where Planner /
    // Evaluator keep talking without making progress). Three consecutive rounds
    // with zero tool calls and near-identical content → terminate.
    const recentContents: string[] = []
    const recentToolCounts: number[] = []
    const LOOP_WINDOW = 3

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
          sessionId: options.sessionId,
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
        // Deduplicate identical tool calls within this round: the model may
        // emit two tool_calls with the same name+args (e.g. pse-review twice).
        // Running both would double-execute a slow/costly tool, so only the
        // first runs; duplicates are short-circuited with a note to the model.
        const seen = new Map<string, number>() // canonical key → index of first
        const keys: (string | null)[] = []
        const firstIdx = new Array<number>(toolCalls.length).fill(-1)
        toolCalls.forEach((call, idx) => {
          const argsStr = canonicalArgs(call.arguments)
          const key = `${call.name}|${argsStr}`
          if (seen.has(key)) {
            firstIdx[idx] = seen.get(key)!
            keys.push(null)
          } else {
            seen.set(key, idx)
            firstIdx[idx] = -1
            keys.push(key)
          }
        })

        interface ExecutedCall {
          call: ToolCall
          result: string
          ok: boolean
          nsId: string
          durationMs: number
          idx: number
        }
        // Run only the first occurrence of each unique call, in parallel.
        const uniqIdx = toolCalls.map((_, i) => i).filter((i) => firstIdx[i] === -1)
        const executed = await Promise.all(
          uniqIdx.map(async (idx): Promise<ExecutedCall> => {
            const call = toolCalls[idx]
            const nsId = this.ns(call.id, runId)
            bus.emit('agent/tool-call', { ...call, id: nsId })
            const t0 = performance.now()

            const schema = toolSchemaByName.get(call.name)
            const needApproval = this.toolNeedsApproval(schema, call.arguments)
            if (needApproval && this.ctx.approval) {
              const decision: ApprovalDecision = await this.ctx.approval.request(
                { ...call, id: nsId },
                bus,
              )
              if (decision === 'reject') {
                const result = `User rejected the tool call "${call.name}" (arguments: ${JSON.stringify(call.arguments)}). Do not call it again; explain or adjust.`
                return { call, result, ok: false, nsId, durationMs: performance.now() - t0, idx }
              }
            }

            const result = await this.ctx.tools.call(call.name, call.arguments, {
              onProgress: (chunk: string) => {
                bus.emit('agent/tool-progress', { id: nsId, chunk })
              },
            })
            const ok = !result.startsWith('error:')
            return { call, result, ok, nsId, durationMs: performance.now() - t0, idx }
          }),
        )
        const byIdx = new Map(executed.map((e) => [e.idx, e]))

        // Reassemble in original order; duplicates get a skip note.
        const ordered: ExecutedCall[] = toolCalls.map((call, idx) => {
          const dup = firstIdx[idx] !== -1
          const nsId = this.ns(call.id, runId)
          const dupCall: ToolCall = { ...call, id: nsId }
          if (dup) {
            bus.emit('agent/tool-call', { ...call, id: nsId })
            const dupOf = toolCalls[firstIdx[idx]]
            const result = `(skipped: "${call.name}" was already called in this same round with identical arguments${JSON.stringify(dupOf.arguments) ? ` ${JSON.stringify(dupOf.arguments)}` : ''} — its result above is reused)`
            return { call: dupCall, result, ok: true, nsId, durationMs: 0, idx }
          }
          return byIdx.get(idx)!
        })

        for (const { call, result, ok, nsId, durationMs } of ordered) {
          toolResults.push({ call, result, ok })
          bus.emit('agent/tool-result', { call: { ...call, id: nsId }, result, ok, durationMs })
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

      // Loop detection: if the model has gone LOOP_WINDOW rounds with zero tool
      // calls and near-identical content, it is spinning (common in PSE mode
      // where Planner/Evaluator keep restating). Bail with the last answer.
      recentContents.push((response.content ?? '').trim())
      recentToolCounts.push(toolCalls.length)
      if (recentContents.length > LOOP_WINDOW) {
        recentContents.shift()
        recentToolCounts.shift()
      }
      if (
        recentContents.length === LOOP_WINDOW &&
        recentToolCounts.every((c) => c === 0) &&
        this.contentsSimilar(recentContents)
      ) {
        const answer = recentContents[recentContents.length - 1] || this.lastAnswer(messages)
        this.ctx.logger('agent').warn('loop detected after %d rounds — terminating early', i + 1)
        bus.emit('agent/done', answer)
        return answer
      }

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
    options: {
      tools?: AgentRunOptions['tools']
      model?: string
      signal?: AbortSignal
      bus?: RunEventBus
      sessionId?: string
    },
  ): Promise<ChatResponse> {
    const callOptions: ChatOptions = {
      tools: options.tools,
      model: options.model,
      signal: options.signal,
      bus: options.bus,
      sessionId: options.sessionId,
    }
    if (!this.ctx.llm.chatStream) return this.ctx.llm.chat(messages, callOptions)

    const bus = options.bus ?? (this.ctx.events as unknown as RunEventBus)
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

  /**
   * Decide whether a tool call needs human approval. Honors a tool's dynamic
   * {@link Tool.approvalWhen} rule (evaluated against the actual call arguments)
   * when present, falling back to the static {@link Tool.needsApproval} flag.
   * Lets e.g. a paid-model provider be gated while the free default is not.
   */
  private toolNeedsApproval(
    schema: Tool | undefined,
    args: string | Record<string, unknown>,
  ): boolean {
    if (!schema) return false
    if (typeof schema.approvalWhen === 'function') {
      const parsed: Record<string, unknown> =
        typeof args === 'string' ? safeParseArgs(args) : (args ?? {})
      return schema.approvalWhen(parsed)
    }
    return !!schema.needsApproval
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

  /**
   * Heuristic: are all strings in the window near-identical? Used by loop
   * detection to bail when the model keeps restating without tool calls.
   * Compares first 80 chars and length ratio — enough to catch "PASS / PASS /
   * PASS" or repeated summaries without false-positiveing genuine long answers.
   */
  private contentsSimilar(texts: string[]): boolean {
    if (texts.length < 2) return false
    const first = texts[0]
    if (!first) return texts.every((t) => !t)
    return texts.every((t) => {
      if (!t) return false
      const lenRatio = Math.min(t.length, first.length) / Math.max(t.length, first.length)
      return lenRatio > 0.8 && t.slice(0, 80) === first.slice(0, 80)
    })
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
      const acc =
        typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
      call.arguments = acc + (d.arguments ?? '')
    }
  }
}
