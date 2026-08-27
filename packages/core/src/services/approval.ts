/**
 * Approval service — human-in-the-loop gate for gated tools.
 *
 * Registered under `ctx.approval`. When the agent loop hits a tool whose
 * schema has `needsApproval: true`, it calls {@link ApprovalService.request}
 * which blocks until a human (via the web UI, CLI, or test harness) resolves
 * the pending request through {@link ApprovalService.resolve}. A request that
 * times out (default 60s) is treated as a rejection, so the loop can never
 * hang forever waiting on a human that isn't there.
 */

import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { RunEventBus, ToolCall } from '../types.js'

export type ApprovalDecision = 'approve' | 'reject'

declare module 'cordis' {
  interface Context {
    approval: ApprovalService
  }
  interface Events {
    'agent/approval-request'(call: ToolCall): void
  }
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void
  timer: NodeJS.Timeout
}

export interface ApprovalConfig {
  /** Milliseconds to wait for a human decision before auto-rejecting. */
  timeout?: number
}

const DEFAULT_TIMEOUT = 60_000

export class ApprovalService extends Service {
  private readonly waiters = new Map<string, PendingApproval>()
  private readonly timeout: number

  constructor(ctx: Context, config: ApprovalConfig = {}) {
    super(ctx, 'approval')
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT
  }

  /**
   * Register a pending approval for a tool call and return a promise that
   * resolves to the human's decision. Emits `agent/approval-request` so
   * observers (web UI) can surface the prompt. When `bus` is supplied the
   * event is scoped to that run; otherwise it goes to the global bus.
   * Auto-rejects on timeout.
   */
  request(call: ToolCall, bus?: RunEventBus): Promise<ApprovalDecision> {
    const existing = this.waiters.get(call.id)
    if (existing) {
      // A previous request with the same id was never resolved (e.g. a retried
      // or re-requested call). Resolve it as 'reject' so its promise doesn't
      // hang forever — a leaked pending promise would keep the event loop
      // alive and memory growing.
      clearTimeout(existing.timer)
      this.waiters.delete(call.id)
      existing.resolve('reject')
      this.ctx
        .logger('approval')
        .warn('superseded pending approval for "%s" (auto-rejected)', call.id)
    }

    return new Promise<ApprovalDecision>((resolve) => {
      ;(bus ?? this.ctx.events).emit('agent/approval-request', call)

      const timer = setTimeout(() => {
        this.waiters.delete(call.id)
        this.ctx
          .logger('approval')
          .warn('approval for tool "%s" timed out, auto-rejecting', call.name)
        resolve('reject')
      }, this.timeout)

      this.waiters.set(call.id, { resolve, timer })
    })
  }

  /**
   * Resolve a pending approval from outside (web API, CLI, tests). Returns
   * false if no request with that call id is pending.
   */
  resolve(callId: string, decision: ApprovalDecision): boolean {
    const pending = this.waiters.get(callId)
    if (!pending) return false
    clearTimeout(pending.timer)
    this.waiters.delete(callId)
    pending.resolve(decision)
    return true
  }
}
