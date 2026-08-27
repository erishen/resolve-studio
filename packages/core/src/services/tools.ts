/**
 * Tool registry service — the callable-tool catalog of the harness.
 *
 * Registered under `ctx.tools`. Tool plugins (`tool-echo`, `tool-calculator`,
 * ...) register themselves here via `ctx.tools.register(...)`. The agent loop
 * reads `ctx.tools.list()` for the LLM schema and calls `ctx.tools.call()` to
 * run a model-requested tool. Every invocation emits a `tools/call` event.
 */

import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { Tool, ToolSchema, ToolExecutionContext } from '../types.js'

/** Options for {@link ToolRegistry.call}. */
export interface ToolCallOptions {
  /**
   * Mark this call as an internal delegation — e.g. a composite tool invoking
   * another tool (see `tool-analyze-code-dir`). Internal calls intentionally
   * skip the agent-loop approval gate (which lives in the loop, not in
   * `call`), because they run as part of an already-approved parent tool and
   * must not spam the user with per-subcall prompts. The flag is also surfaced
   * on the `tools/call` event so observers can distinguish delegated calls.
   */
  internal?: boolean
  /** Progress callback for long-running tools. */
  onProgress?: (chunk: string) => void
}

declare module 'cordis' {
  interface Context {
    tools: ToolRegistry
  }
  interface Events {
    'tools/call'(payload: {
      name: string
      args: unknown
      ok: boolean
      result: string
      internal?: boolean
    }): void
  }
}

export class ToolRegistry extends Service {
  private readonly registry = new Map<string, Tool>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** Register (or replace) a tool. */
  register(tool: Tool): void {
    this.registry.set(tool.name, tool)
    this.ctx.logger('tools').debug('registered %s', tool.name)
  }

  /** Remove a tool by name. */
  unregister(name: string): void {
    this.registry.delete(name)
  }

  /** All registered tools. */
  list(): Tool[] {
    return [...this.registry.values()]
  }

  /** Tool schemas for the LLM. */
  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.needsApproval !== undefined ? { needsApproval: t.needsApproval } : {}),
    }))
  }

  /** Look up a single tool. */
  get(name: string): Tool | undefined {
    return this.registry.get(name)
  }

  /**
   * Call a tool by name.
   *
   * `args` may be a JSON string (as returned by the model) or an already-parsed
   * object. Failures are caught and returned as an error string so the agent
   * loop can continue instead of crashing.
   */
  async call(
    name: string,
    args: string | Record<string, unknown>,
    opts: ToolCallOptions = {},
  ): Promise<string> {
    const tool = this.registry.get(name)
    if (!tool) {
      const result = `error: unknown tool "${name}"`
      this.ctx.events.emit('tools/call', { name, args, ok: false, result, internal: opts.internal })
      return result
    }
    let parsed: Record<string, unknown>
    try {
      parsed = typeof args === 'string' ? (args ? JSON.parse(args) : {}) : args
    } catch (err) {
      const result = `error: invalid JSON arguments for ${name}: ${(err as Error).message}`
      this.ctx.events.emit('tools/call', { name, args, ok: false, result, internal: opts.internal })
      return result
    }
    try {
      const execCtx: ToolExecutionContext = opts.onProgress ? { onProgress: opts.onProgress } : {}
      const out = await tool.execute(parsed, execCtx)
      const result = typeof out === 'string' ? out : JSON.stringify(out)
      this.ctx.events.emit('tools/call', {
        name,
        args: parsed,
        ok: true,
        result,
        internal: opts.internal,
      })
      return result
    } catch (err) {
      const result = `error: ${tool.name} failed: ${(err as Error).message}`
      this.ctx.events.emit('tools/call', {
        name,
        args: parsed,
        ok: false,
        result,
        internal: opts.internal,
      })
      return result
    }
  }
}
