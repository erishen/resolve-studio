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
  AgentToolFilter,
  AgentStep,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatStreamChunk,
  RunEventBus,
  Tool,
  ToolCall,
  ToolSchema,
} from '../types.js'
import type { ApprovalDecision } from './approval.js'
import { fitContextWithSummary } from '../context.js'

/** Best-effort parse of tool arguments that arrive as a JSON string. */
function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Shorten a (tool-error) string for embedding in a nudge message. */
function truncateForNudge(s: string, max = 240): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
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

/** Cap on how many "declared but not executed" nudges a single run gets before
 *  the loop gives up and terminates (prevents a model that only promises to
 *  call tools from burning the whole iteration budget). */
const MAX_PLAN_INTERRUPTS = 2

/**
 * Natural-language aliases → tool name. Models often write their next step in
 * prose ("生成小红书文案", "校验一下合规") WITHOUT naming the underlying tool,
 * so plain instrument-name matching misses them. These trigger phrases pair a
 * concrete action with the tool that performs it; the existing intent-verb
 * check still applies, and executed tools are never re-flagged.
 */
const TOOL_ALIASES: Record<string, string[]> = {
  'hot-news': ['生成文案', '小红书文案', '营销文案', '写一篇.*文案', '生成.*文案'],
  'hot-news-check': ['校验合规', '检查合规', '合规校验', '校验.*合规', '检查.*合规'],
  'hot-news-topics': ['列话题', '话题候选', '列.*话题', '列出话题'],
  'hot-news-fetch': ['抓取.*素材', '抓素材', '抓取.*热点', '热点素材'],
}

/**
 * Detect a reply that *names* a not-yet-executed tool with an intent verb but
 * never actually calls it — e.g. "用 hot-news 生成文案" with no tool-call.
 * Returns the tool name to nudge, or `null` when the reply is a genuine final
 * answer. Execution is judged against the conversation: a tool that already
 * produced a `tool` turn is considered done, so a summary that mentions it is
 * not flagged. Only checks tools the model can currently see. Matching is
 * two-layered: first by literal tool name + intent verb, then by natural
 * language alias phrases (see {@link TOOL_ALIASES}) for prose-only steps.
 */
function findDeclaredToolCall(
  text: string,
  tools: ToolSchema[],
  messages: ChatMessage[],
): string | null {
  if (!text) return null
  const executed = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.name) executed.add(m.name)
  }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // "用 X 做 Y" / "调用 X" / "通过 X 保存" — intent verbs that pair a tool name
  // with a follow-through action, matching the model's own phrasing style.
  const intentVerbs = ['用', '使用', '调用', '通过', '以', '拿', '借助']
  for (const t of tools) {
    if (executed.has(t.name)) continue
    const name = esc(t.name)
    const bare = new RegExp(name)
    if (!bare.test(text)) continue
    // Require an intent verb within a few chars BEFORE the tool name so a
    // passive mention ("hot-news 是…") isn't treated as a plan.
    const before = text.split(t.name)[0] ?? ''
    const tail = before.slice(-12)
    if (intentVerbs.some((v) => tail.includes(v))) return t.name
  }
  // Fallback: the model phrased the step in natural language without naming the
  // tool (e.g. "生成小红书文案" rather than "调用 hot-news"). Match alias
  // trigger phrases — these already encode an action so no extra verb needed.
  for (const [tool, patterns] of Object.entries(TOOL_ALIASES)) {
    if (executed.has(tool)) continue
    for (const p of patterns) {
      if (new RegExp(p).test(text)) return tool
    }
  }
  return null
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
    'agent/done'(answer: string | { answer: string; failedToolCalls: number }): void
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
    // A per-run `options.pse` overrides the global `ctx.pse.enabled` flag, so
    // background jobs can force PSE on while interactive chat keeps it off.
    const pseActive = options.pse ?? (this.ctx.pse?.enabled ?? false)
    const maxIterations = options.maxIterations ?? (pseActive ? 15 : 8)
    // A per-run include/exclude filter (see `AgentToolFilter`) prunes BOTH the
    // schema the LLM sees and the approval map below, so a filtered-out tool is
    // never advertised to the model nor approved. This is the main lever for
    // cutting fixed token overhead when only a few MCP servers/built-ins matter
    // for a given task. `toolDefs` are the full Tool definitions (incl. the
    // dynamic `approvalWhen` rule) used by the approval gate; `toolsForLlm` is
    // the sanitized schema forwarded to the model.
    //
    // Filter precedence: an explicit per-run filter wins (the caller knows the
    // exact surface it needs); otherwise a forced `taskId` pins that task's
    // whitelist (manual control); otherwise the run auto-narrows to whichever
    // task matches the latest user message. Falls back to the full registry for
    // open-ended requests.
    const explicitFilter: AgentToolFilter =
      options.includeTools || options.excludeTools
        ? { includeTools: options.includeTools, excludeTools: options.excludeTools }
        : {}
    const activeTaskOptions =
      explicitFilter.includeTools || explicitFilter.excludeTools
        ? undefined
        : this.resolveTaskFilter(options)
    const activeFilter: AgentToolFilter = activeTaskOptions ?? explicitFilter

    const filtered = this.filterTools(
      options.tools ? (options.tools as unknown as Tool[]) : this.ctx.tools.list(),
      activeFilter,
    )
    const toolDefs: Tool[] = filtered
    const toolsForLlm: ToolSchema[] = filtered.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.needsApproval !== undefined ? { needsApproval: t.needsApproval } : {}),
      ...(t.fromMcp !== undefined ? { fromMcp: t.fromMcp } : {}),
    }))
    const toolSchemaByName = new Map<string, Tool>(toolDefs.map((t) => [t.name, t]))
    // Per-run approval memo: a gated tool that has already been human-approved
    // once in this run is not re-prompted on subsequent calls (e.g. the model
    // re-invoking the same gated tool across iterations). Rejected tools are NOT
    // memoized, so a retry still asks the human again.
    const approvedTools = new Set<string>()
    // Track how many tool calls finished with `ok: false` so the caller can
    // report overall failure status (e.g. background job status).
    let failedToolCalls = 0
    // How many times we nudged the model to actually emit a planned tool-call
    // (see the "declare without calling" guard in the loop). Bounded so a model
    // that keeps promising but never calls still terminates.
    let planInterrupts = 0
    // Per-run event sink: when the caller supplies one (the web bridge does,
    // once per HTTP request) every `agent/*` / `llm/*` event is scoped to that
    // run so concurrent chats don't cross-talk. Without it we fall back to the
    // global `ctx.events` bus, which keeps the CLI's `ctx.events.on(...)` and
    // the tests' observers working unchanged.
    const bus: RunEventBus = options.bus ?? (this.ctx.events as unknown as RunEventBus)
    // Bound the conversation to the context window before anything else. A
    // pre-budget (cheaper than the per-message cap in llm-openai.ts) plus a
    // rolling summary keeps long sessions coherent: when old messages are
    // dropped, a cheap tool-free LLM call compresses them into a summary that
    // replaces the terse "omitted" note.
    const messages: ChatMessage[] = await fitContextWithSummary(
      options.messages.map((m) => ({ ...m })),
      {
        maxChars: options.contextBudgetChars ?? this.budgetChars,
        summarize: (dropped) =>
          this.summarizeDropped(dropped, {
            model: options.model,
            signal: options.signal,
            bus,
            sessionId: options.sessionId,
          }),
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
        bus.emit('agent/done', { answer, failedToolCalls: 0 })
        return answer
      }
    }

    // Environment briefing: tell the model about the sandbox and file-writing
    // conventions so it doesn't waste a call on /home/user/ paths or miss the
    // task-level directory isolation.
    const envBrief = [
      '## 运行环境',
      '- 所有 shell 命令和文件写入都在沙箱中运行，无法写入工作目录和系统临时目录之外的位置。',
      // A per-run workspace overrides the default sandbox/<task>/ convention:
      // relative paths and shell cwd are anchored to the workspace, so the model
      // just writes bare filenames and they land in the job's own directory.
      ...(options.workspace
        ? [
            `- 本次运行的工作区（working directory）：${options.workspace}`,
            '- write-file / read-file 的相对路径都以该工作区为基准，**直接写文件名即可**，不要拼路径前缀。',
            '- shell 命令的工作目录就是这个工作区；产物（中间文件、报告等）都应写到工作区里，方便后续查看与续跑。',
          ]
        : [
            '- write-file 工具：相对路径会自动写入 sandbox/<task>/ 目录，**直接写文件名即可，不要加 sandbox/ 前缀**。例如 path: "lru_cache.py" + task: "lru-cache" → 实际写入 sandbox/lru-cache/lru_cache.py。',
            '- 务必传入 task 参数（如 task: "lru-cache"）为每个任务创建独立子目录，不要直接写在 sandbox 根目录。',
            '- shell 命令中访问文件时，使用完整路径 sandbox/<task>/<filename>，或 cd 到该目录后运行。',
          ]),
      '- 不要使用 /home/user/、/root/ 等绝对路径写入文件；读取文件可以用绝对路径。',
      '- shell 命令的工作目录是项目根目录，可正常运行 pnpm、node、python 等命令；如缺少依赖（如 pytest），用 python 直接运行脚本或先 pip install。',
      '- serena:* 工具需要先调用 serena:activate_project 激活项目；如果报 "No active project"，不要反复调用，改用内置的 read-file/write-file 工具。',
      '- 如果某个工具连续调用失败，换一种方式实现，不要反复重试消耗迭代次数。',
      '- 关于重试的硬性要求：当你发现某次工具调用失败、需要"再试一次"时，必须真正发出一个新的 tool-call 来执行它；仅仅在回复文本里写"我再试一次 / 刚才失败了"而不实际调用工具，等同于没做，禁止这样空口承诺。若之前某次调用已经成功产出可复用结果，则应直接基于该结果继续/汇报，不要为无效目标重复调用。',
      '- 避免重复调用：同一个技能（skill-run）只加载一次；同一个工具如果已经在本轮对话中执行过且结果仍有效，不要再次调用。尤其：技能加载一次后直接按其中步骤执行，不要重复 skill-run；portfolio-check 体检一次通过后直接进入下一步，不要重复体检。',
      '- 强制产出（最重要）：只要任务还有下一步要执行，就必须**直接发出对应的 tool-call**；仅仅在回复文本里叙述"接下来要用 XX 工具做 YY / 第二步生成文案"而**没有实际发出 tool-call**，视为任务未完成，会被系统视作中断。请把每个工具调用作为独立的 tool-call 发出来，避免只输出计划或散文式声明。',
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
    if (pseActive) {
      const psePrompt = await this.ctx.pse?.systemPrompt(pseActive)
      if (psePrompt) messages.unshift({ role: 'system', content: psePrompt })
    }

    // Caller-supplied system prompt (role preset / task instructions). Inserted
    // after the skills index so it takes precedence as the topmost instruction.
    // A matched task's system prompt rides along with (above) the caller's, so
    // the model knows it is restricted to the task's professional tool set.
    if (activeTaskOptions?.systemPrompt || options.systemPrompt) {
      const parts = [activeTaskOptions?.systemPrompt, options.systemPrompt].filter(Boolean)
      messages.unshift({ role: 'system', content: parts.join('\n\n') })
    }

    const runId = options.runId

    // Loop detection: track recent assistant contents and tool-call counts so we
    // can bail early when the model is spinning (e.g. PSE mode where Planner /
    // Evaluator keep talking without making progress). Three consecutive rounds
    // with zero tool calls and near-identical content → terminate.
    const recentContents: string[] = []
    const recentToolCounts: number[] = []
    const LOOP_WINDOW = 3

    // Repeated-failure guard: when the same tool fails N times consecutively
    // the model is usually banging against an unavoidable wall (file too big,
    // sandbox path, provider error). Nudge it to change approach instead of
    // letting it burn iteration budget retrying. A success resets the streak;
    // each tool is only nudged once per run.
    const failedStreaks = new Map<string, number>()
    const toolNudged = new Set<string>()
    const FAIL_THRESHOLD = 2

    for (let i = 0; i < maxIterations; i++) {
      // Allow an in-flight run to be cancelled between steps.
      if (options.signal?.aborted) {
        const partial = this.lastAnswer(messages)
        bus.emit('agent/done', { answer: partial, failedToolCalls })
        return partial
      }

      let response: ChatResponse
      try {
        response = await this.nextResponse(messages, {
          tools: toolsForLlm.length ? toolsForLlm : undefined,
          model: options.model,
          signal: options.signal,
          bus,
          sessionId: options.sessionId,
        })
      } catch (err) {
        // Aborted mid-stream: stop and return whatever we have so far.
        if (options.signal?.aborted || (err as Error)?.name === 'AbortError') {
          const partial = this.lastAnswer(messages)
          bus.emit('agent/done', { answer: partial, failedToolCalls })
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
            const t0 = performance.now()

            const schema = toolSchemaByName.get(call.name)
            // skipApproval (background jobs) treats every tool as pre-approved:
            // unattended runs must not block on the human-in-the-loop gate or
            // auto-reject on the 60s timeout.
            const needApproval =
              !options.skipApproval && this.toolNeedsApproval(schema, call.arguments)
            // Empty-arguments guard: the model sometimes emits a tool-call with
            // no args at all (e.g. `write-file` with `{}`). Running it is
            // guaranteed to fail with a terse "path is required". Instead,
            // short-circuit with a clear message listing the missing required
            // fields so the model can fix the call in one go. Only applied to
            // non-gated tools — a gated call still goes through the approval
            // flow so the human stays in the loop.
            if (!needApproval) {
              const missing = this.missingRequiredArgs(schema, call.arguments)
              if (missing.length) {
                const result = `error: 工具 "${call.name}" 缺少必填参数：${missing.join(', ')}。请带上这些参数重新调用（参数说明见工具定义）。`
                return { call, result, ok: false, nsId, durationMs: performance.now() - t0, idx }
              }
            }
            // Skip re-prompting a gated tool already approved once this run.
            const approvalSkipped = needApproval && approvedTools.has(call.name)
            bus.emit('agent/tool-call', { ...call, id: nsId, approvalSkipped: !!approvalSkipped })
            if (needApproval && this.ctx.approval && !approvalSkipped) {
              const decision: ApprovalDecision = await this.ctx.approval.request(
                { ...call, id: nsId },
                bus,
              )
              if (decision === 'approve') approvedTools.add(call.name)
              if (decision === 'reject') {
                const result = `User rejected the tool call "${call.name}" (arguments: ${JSON.stringify(call.arguments)}). Do not call it again; explain or adjust.`
                return { call, result, ok: false, nsId, durationMs: performance.now() - t0, idx }
              }
            }

            const result = await this.ctx.tools.call(call.name, call.arguments, {
              onProgress: (chunk: string) => {
                bus.emit('agent/tool-progress', { id: nsId, chunk })
              },
              ...(options.workspace ? { workspace: options.workspace } : {}),
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
          if (!ok) failedToolCalls++
          bus.emit('agent/tool-result', { call: { ...call, id: nsId }, result, ok, durationMs })
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result,
          })
          // Repeated-failure guard: reset the streak on success, otherwise
          // count up and inject a "change approach" nudge at the threshold.
          if (ok) {
            failedStreaks.delete(call.name)
          } else {
            const streak = (failedStreaks.get(call.name) ?? 0) + 1
            failedStreaks.set(call.name, streak)
            if (streak >= FAIL_THRESHOLD && !toolNudged.has(call.name)) {
              toolNudged.add(call.name)
              this.ctx.logger('agent').warn(
                'tool "%s" failed %d× consecutively — nudging the model to change approach',
                call.name,
                streak,
              )
              messages.push({
                role: 'user',
                content:
                  `工具 \`${call.name}\` 已连续失败 ${streak} 次（最近一次错误：${truncateForNudge(result)}）。` +
                  `不要再用相同参数重试它。请换一种方式完成任务，或直接基于已有结果继续并汇报；` +
                  `如果确实需要该能力但被限制（如文件过大 / 路径在沙箱外），就明确说明并给出替代方案。`,
              })
            }
          }
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
        bus.emit('agent/done', { answer, failedToolCalls })
        return answer
      }

      if (!toolCalls.length) {
        // Trim leading/trailing whitespace: many LLM outputs start with a
        // blank line, which would otherwise leak into the UI as an empty line
        // at the top of the answer bubble.
        const answer = (response.content ?? '').trim()
        // A model that only "declares" its next tool step in prose — e.g. "用
        // hot-news 生成文案" — without emitting an actual tool-call must not be
        // treated as done: the pipeline silently stops mid-way. If the reply
        // names an as-yet-unexecuted tool with an intent verb, nudge the model
        // to really call it (bounded, so a stubborn model still terminates).
        const declared = findDeclaredToolCall(answer, toolsForLlm, messages)
        if (declared && planInterrupts < MAX_PLAN_INTERRUPTS) {
          planInterrupts++
          this.ctx.logger('agent').warn(
            'round %d declared tool "%s" without a tool-call — nudging',
            i + 1,
            declared,
          )
          messages.push({
            role: 'user',
            content:
              `你的上一条回复只是描述了计划，并没有真正调用工具 \`${declared}\`。` +
              `请立即发出一个 tool-call 来执行它（参数参照工具说明），执行完再汇报结果。`,
          })
          continue
        }
        bus.emit('agent/done', { answer, failedToolCalls })
        return answer
      }
    }

    const fallback = 'Reached the maximum number of iterations without a final answer.'
    this.ctx.logger('agent').warn(fallback)
    bus.emit('agent/done', { answer: fallback, failedToolCalls })
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
   * No-throw accessor to the optional `tasks` service. Returns undefined when
   * the plugin isn't loaded (offline/test setups), keeping open-ended runs on
   * the full toolset instead of crashing the loop.
   */
  private tasksService():
    | {
        resolve(
          taskId: string | undefined,
          messages: { role: string; content: unknown }[],
        ): { includeTools: string[]; excludeTools?: string[]; systemPrompt?: string } | undefined
      }
    | undefined {
    try {
      return this.ctx.get('tasks') as never
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the run's task-specific filter. A forced `taskId` pins that task's
   * professional tool whitelist (manual control, bypassing intent matching);
   * otherwise the latest user message is matched against the registry. Returns
   * the task's whitelist options, or undefined when no task applies.
   */
  private resolveTaskFilter(
    options: AgentRunOptions,
  ): { includeTools: string[]; excludeTools?: string[]; systemPrompt?: string } | undefined {
    const tasks = this.tasksService()
    if (!tasks) return undefined
    try {
      // Delegates all routing (auto intenent-match, scope id, business task id,
      // unknown id) to the tasks service. Unknown ids return undefined → the
      // caller keeps the full toolset.
      return tasks.resolve(options.taskId, options.messages)
    } catch {
      return undefined
    }
  }

  /**
   * Prune the run's tool set by the per-run include/exclude filter. An entry is
   * a prefix matcher: a bare server id (`"serena"`) keeps all `serena:*` MCP
   * tools, a full built-in name (`"tool-read-file"`) keeps exactly that tool.
   * No filter → the full registry passes through unchanged.
   */
  private filterTools(all: Tool[], filter: AgentToolFilter): Tool[] {
    const { includeTools, excludeTools } = filter
    let out = all
    if (includeTools?.length) {
      out = out.filter((t) => includeTools.some((p) => t.name.startsWith(p)))
    }
    if (excludeTools?.length) {
      out = out.filter((t) => !excludeTools.some((p) => t.name.startsWith(p)))
    }
    return out
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

  /**
   * Required top-level parameters declared by the tool's schema that are
   * missing from the call arguments. Used to short-circuit an empty/partial
   * tool-call (the model firing a call with `{}` args) with a precise error
   * instead of letting the tool fail with a terse message. Only the top-level
   * `parameters.required` list is checked.
   */
  private missingRequiredArgs(
    schema: Tool | undefined,
    args: string | Record<string, unknown>,
  ): string[] {
    if (!schema) return []
    const required = schema.parameters?.required
    if (!required?.length) return []
    const parsed: Record<string, unknown> =
      typeof args === 'string' ? safeParseArgs(args) : (args ?? {})
    return required.filter((k) => k in parsed === false)
  }

  /** Best-effort answer recovered from a partially-run conversation. */
  private lastAnswer(messages: ChatMessage[]): string {
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    const text = last && typeof last.content === 'string' ? last.content.trim() : ''
    return text || 'Run stopped before a final answer was produced.'
  }

  /**
   * Compress a dropped message region into a short summary via a cheap,
   * tool-free LLM call (the "rolling summary" upgrade for fitContext). The
   * summary preserves the gist of earlier steps — user requests, key tool
   * calls and outcomes — so a long session doesn't lose semantic memory when
   * the context window is trimmed. Rejects on any LLM failure so the caller
   * falls back to the terse omit-note.
   */
  private async summarizeDropped(
    dropped: ChatMessage[],
    opts: { model?: string; signal?: AbortSignal; bus?: RunEventBus; sessionId?: string },
  ): Promise<string> {
    const prompt: ChatMessage = {
      role: 'user',
      content:
        '以下是对话历史中因上下文超限被截断的较早部分。请用中文写一段 100-200 字的' +
        '简明摘要，涵盖：用户的核心目标与需求、做过哪些关键步骤、调用了哪些重要工具及结果、' +
        '目前进度和遗留问题。不要编造未发生的事，直接输出摘要正文，不要加标题或前后缀。',
    }
    const res = await this.ctx.llm.chat([...dropped, prompt], {
      model: opts.model,
      signal: opts.signal,
      bus: opts.bus,
      sessionId: opts.sessionId,
      // Tool-free: the summarizer must just write prose, not call tools.
      toolChoice: 'none',
    })
    return (res.content ?? '').trim()
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
