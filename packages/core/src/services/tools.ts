/**
 * Tool registry service — the callable-tool catalog of the harness.
 *
 * Registered under `ctx.tools`. Tool plugins (`tool-echo`, `tool-calculator`,
 * ...) register themselves here via `ctx.tools.register(...)`. The agent loop
 * reads `ctx.tools.list()` for the LLM schema and calls `ctx.tools.call()` to
 * run a model-requested tool. Every invocation emits a `tools/call` event.
 */

import { Context, Service } from 'cordis'
import type { Tool, ToolSchema } from '../types.js'

declare module 'cordis' {
  interface Context {
    tools: ToolRegistry
  }
  interface Events {
    'tools/call'(payload: { name: string; args: unknown; ok: boolean; result: string }): void
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
  async call(name: string, args: string | Record<string, unknown>): Promise<string> {
    const tool = this.registry.get(name)
    if (!tool) {
      const result = `error: unknown tool "${name}"`
      this.ctx.events.emit('tools/call', { name, args, ok: false, result })
      return result
    }
    let parsed: Record<string, unknown>
    try {
      parsed = typeof args === 'string' ? (args ? JSON.parse(args) : {}) : args
    } catch (err) {
      const result = `error: invalid JSON arguments for ${name}: ${(err as Error).message}`
      this.ctx.events.emit('tools/call', { name, args, ok: false, result })
      return result
    }
    try {
      const out = await tool.execute(parsed)
      const result = typeof out === 'string' ? out : JSON.stringify(out)
      this.ctx.events.emit('tools/call', { name, args: parsed, ok: true, result })
      return result
    } catch (err) {
      const result = `error: ${tool.name} failed: ${(err as Error).message}`
      this.ctx.events.emit('tools/call', { name, args: parsed, ok: false, result })
      return result
    }
  }
}
