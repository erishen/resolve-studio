/**
 * Usage service — tracks token consumption and estimated cost across a run.
 *
 * Registered under `ctx.usage`. The LLM adapter calls {@link UsageService.record}
 * after every completion (chat or the final stream chunk); the service
 * accumulates prompt/completion tokens and computes an estimated cost from a
 * per-model price table. A `llm/usage` event is emitted on each record so the
 * web bridge can stream the running tally to the UI.
 *
 * Totals are tracked both globally (process lifetime) and per-session (when a
 * `sessionId` is supplied to `record`). The web UI passes the current
 * conversation id so each chat shows its own cost instead of a running total
 * across every session.
 *
 * Prices are estimates in CNY per 1K tokens (input / output) and can be
 * overridden via the `HARNESS_PRICES` env var (JSON map keyed by model id).
 * Models not in the table fall back to the `default` entry.
 */

import type { Context } from 'cordis'
import { Service } from 'cordis'
import type { RunEventBus } from '../types.js'

declare module 'cordis' {
  interface Context {
    usage: UsageService
  }
  interface Events {
    'llm/usage'(record: UsageRecord): void
  }
}

export interface UsageRecord {
  model: string
  promptTokens: number
  completionTokens: number
  cost: number
  /** Session id this record belongs to (undefined when untracked). */
  sessionId?: string
}

export interface UsageSnapshot {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalCost: number
  requests: number
  byModel: Record<
    string,
    { promptTokens: number; completionTokens: number; cost: number; requests: number }
  >
}

type PriceTable = Record<string, { in: number; out: number }>

interface SessionTotals {
  totalPrompt: number
  totalCompletion: number
  totalCost: number
  requests: number
  byModel: UsageSnapshot['byModel']
}

const DEFAULT_PRICES: PriceTable = {
  'deepseek-chat': { in: 0.002, out: 0.008 },
  'deepseek-v4-flash': { in: 0.001, out: 0.004 },
  'deepseek-reasoner': { in: 0.004, out: 0.016 },
  'gpt-4o': { in: 0.025, out: 0.075 },
  'gpt-4o-mini': { in: 0.00075, out: 0.003 },
  default: { in: 0.005, out: 0.015 },
}

function loadPrices(): PriceTable {
  const raw = process.env['HARNESS_PRICES']
  if (!raw) return DEFAULT_PRICES
  try {
    const parsed = JSON.parse(raw) as PriceTable
    return { ...DEFAULT_PRICES, ...parsed }
  } catch {
    return DEFAULT_PRICES
  }
}

function emptyTotals(): SessionTotals {
  return { totalPrompt: 0, totalCompletion: 0, totalCost: 0, requests: 0, byModel: {} }
}

export class UsageService extends Service {
  private readonly prices: PriceTable = loadPrices()
  private readonly global: SessionTotals = emptyTotals()
  private readonly bySession = new Map<string, SessionTotals>()

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  /** Record a completed completion's token usage and emit an event.
   *  When `bus` is supplied the event is scoped to that run (so concurrent
   *  runs don't cross-talk); otherwise it goes to the global bus.
   *  When `sessionId` is supplied the totals are also attributed to that
   *  session (retrievable via {@link snapshot}). */
  record(
    model: string,
    promptTokens: number,
    completionTokens: number,
    bus?: RunEventBus,
    sessionId?: string,
  ): UsageRecord {
    const price = this.prices[model] ?? this.prices['default']
    const cost = (promptTokens / 1000) * price.in + (completionTokens / 1000) * price.out

    this.addTo(this.global, model, promptTokens, completionTokens, cost)

    if (sessionId) {
      let sess = this.bySession.get(sessionId)
      if (!sess) {
        sess = emptyTotals()
        this.bySession.set(sessionId, sess)
      }
      this.addTo(sess, model, promptTokens, completionTokens, cost)
    }

    const record: UsageRecord = { model, promptTokens, completionTokens, cost, sessionId }
    ;(bus ?? this.ctx.events).emit('llm/usage', record)
    return record
  }

  private addTo(
    target: SessionTotals,
    model: string,
    promptTokens: number,
    completionTokens: number,
    cost: number,
  ): void {
    target.totalPrompt += promptTokens
    target.totalCompletion += completionTokens
    target.totalCost += cost
    target.requests += 1
    const agg = (target.byModel[model] ??= {
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      requests: 0,
    })
    agg.promptTokens += promptTokens
    agg.completionTokens += completionTokens
    agg.cost += cost
    agg.requests += 1
  }

  private toSnapshot(t: SessionTotals): UsageSnapshot {
    return {
      totalPromptTokens: t.totalPrompt,
      totalCompletionTokens: t.totalCompletion,
      totalTokens: t.totalPrompt + t.totalCompletion,
      totalCost: t.totalCost,
      requests: t.requests,
      byModel: t.byModel,
    }
  }

  /** Current cumulative totals. Pass a `sessionId` to get that session's
   *  totals instead of the global ones; returns an empty snapshot for an
   *  unknown session id. */
  snapshot(sessionId?: string): UsageSnapshot {
    if (!sessionId) return this.toSnapshot(this.global)
    return this.toSnapshot(this.bySession.get(sessionId) ?? emptyTotals())
  }

  /** Reset counters. Pass a `sessionId` to reset only that session; without
   *  an id both global and all per-session counters are cleared. */
  reset(sessionId?: string): void {
    if (sessionId) {
      this.bySession.delete(sessionId)
      return
    }
    Object.assign(this.global, emptyTotals())
    this.bySession.clear()
  }
}
