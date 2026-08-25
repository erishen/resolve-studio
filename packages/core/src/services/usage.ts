/**
 * Usage service — tracks token consumption and estimated cost across a run.
 *
 * Registered under `ctx.usage`. The LLM adapter calls {@link UsageService.record}
 * after every completion (chat or the final stream chunk); the service
 * accumulates prompt/completion tokens and computes an estimated cost from a
 * per-model price table. A `llm/usage` event is emitted on each record so the
 * web bridge can stream the running tally to the UI.
 *
 * Prices are estimates in CNY per 1K tokens (input / output) and can be
 * overridden via the `HARNESS_PRICES` env var (JSON map keyed by model id).
 * Models not in the table fall back to the `default` entry.
 */

import { Context, Service } from 'cordis'
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
}

export interface UsageSnapshot {
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalCost: number
  requests: number
  byModel: Record<string, { promptTokens: number; completionTokens: number; cost: number; requests: number }>
}

type PriceTable = Record<string, { in: number; out: number }>

const DEFAULT_PRICES: PriceTable = {
  'deepseek-chat': { in: 0.002, out: 0.008 },
  'deepseek-v4-flash': { in: 0.001, out: 0.004 },
  'deepseek-reasoner': { in: 0.004, out: 0.016 },
  'agnes-2.0-flash': { in: 0, out: 0 },
  'agnes-2.0': { in: 0, out: 0 },
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

export class UsageService extends Service {
  private readonly prices: PriceTable = loadPrices()
  private totalPrompt = 0
  private totalCompletion = 0
  private totalCost = 0
  private requests = 0
  private readonly byModel: UsageSnapshot['byModel'] = {}

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  /** Record a completed completion's token usage and emit an event.
   *  When `bus` is supplied the event is scoped to that run (so concurrent
   *  runs don't cross-talk); otherwise it goes to the global bus. */
  record(model: string, promptTokens: number, completionTokens: number, bus?: RunEventBus): UsageRecord {
    const price = this.prices[model] ?? this.prices['default']
    const cost = (promptTokens / 1000) * price.in + (completionTokens / 1000) * price.out

    this.totalPrompt += promptTokens
    this.totalCompletion += completionTokens
    this.totalCost += cost
    this.requests += 1

    const agg = (this.byModel[model] ??= { promptTokens: 0, completionTokens: 0, cost: 0, requests: 0 })
    agg.promptTokens += promptTokens
    agg.completionTokens += completionTokens
    agg.cost += cost
    agg.requests += 1

    const record: UsageRecord = { model, promptTokens, completionTokens, cost }
    ;(bus ?? this.ctx.events).emit('llm/usage', record)
    return record
  }

  /** Current cumulative totals. */
  snapshot(): UsageSnapshot {
    return {
      totalPromptTokens: this.totalPrompt,
      totalCompletionTokens: this.totalCompletion,
      totalTokens: this.totalPrompt + this.totalCompletion,
      totalCost: this.totalCost,
      requests: this.requests,
      byModel: this.byModel,
    }
  }

  /** Reset all counters (e.g. on a new session). */
  reset(): void {
    this.totalPrompt = 0
    this.totalCompletion = 0
    this.totalCost = 0
    this.requests = 0
    for (const k of Object.keys(this.byModel)) delete this.byModel[k]
  }
}
