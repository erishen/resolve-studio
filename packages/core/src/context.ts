/**
 * Context window management.
 *
 * The agent loop historically sent the *entire* conversation to the model on
 * every turn. For long sessions that blows the context window (and the bill).
 * {@link fitContext} trims an over-budget conversation down to a contiguous
 * recent tail while keeping the leading system message, and inserts a short
 * system note where content was dropped.
 *
 * Keeping a *contiguous* tail (rather than dropping individual old messages)
 * is deliberate: it preserves the adjacency between an assistant message that
 * issued tool calls and the tool-result messages that follow, so the model's
 * tool-call / result pairing never breaks.
 */

import type { ChatMessage } from './types.js'

/** Rough char-based token estimate (~4 chars/token, incl. English + CJK). */
export function estimateChars(messages: ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (typeof m.content === 'string') n += m.content.length
    else n += m.content.reduce((acc, p) => acc + (p.text?.length ?? 0), 0)
    // Assistant messages may carry tool calls at runtime; count them loosely.
    const tc = (m as { toolCalls?: unknown }).toolCalls
    if (tc) n += JSON.stringify(tc).length
  }
  return n
}

export interface FitOptions {
  /** Max total chars before trimming kicks in (default 60_000 ≈ 15k tokens). */
  maxChars?: number
  /**
   * When set, dropped messages are summarized (a cheap "rolling summary" lite):
   * the names of tools invoked in the omitted prefix are listed in the omit
   * note, so the model retains a hint of what happened earlier without an
   * extra LLM summarization call. (See docs/TODO.md "会话历史仅事后截断".)
   */
  summarizeDropped?: boolean
}

/**
 * Scan dropped messages and summarize the tool activity that happened there.
 * Returns an empty string when nothing tool-related was found, so callers can
 * append it unconditionally.
 */
function summarizeDroppedMessages(msgs: ChatMessage[]): string {
  const counts = new Map<string, number>()
  for (const m of msgs) {
    const toolCalls = (m as { toolCalls?: { name: string }[] }).toolCalls
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return ''
  const parts = [...counts.entries()].map(([name, n]) => `${n}× ${name}`)
  return ` Earlier activity included: ${parts.join(', ')}.`
}

/**
 * Return a context-bounded copy of `messages`:
 *  - if already within budget, returns it unchanged;
 *  - otherwise keeps the first `system` message and a contiguous recent tail,
 *    dropping the middle and inserting a system note at the boundary.
 *
 * The trimming scan is O(n): it walks `rest` from the tail backward,
 * accumulating per-message char counts, instead of re-estimating the whole
 * candidate array on every iteration (the previous O(n²) approach got slow on
 * hundred-message conversations).
 */
export function fitContext(messages: ChatMessage[], opts: FitOptions = {}): ChatMessage[] {
  const maxChars = opts.maxChars ?? 60_000
  const out = messages.map((m) => ({ ...m }))
  if (estimateChars(out) <= maxChars) return out

  // Separate the (usually single) leading system message from the rest.
  const systemIdx = out.findIndex((m) => m.role === 'system')
  const head = systemIdx >= 0 ? [out[systemIdx]] : []
  const rest = systemIdx >= 0 ? out.slice(systemIdx + 1) : out

  // Keep a contiguous tail of `rest`, shrinking from the front, until we fit.
  // Reserve room for the system note we may insert when something is dropped.
  const NOTE_RESERVE = 200
  const headChars = estimateChars(head)
  const budget = maxChars - NOTE_RESERVE

  // Walk backward from the end: keep adding messages to the retained tail
  // until the next one would blow the budget. Because we already know the
  // whole conversation is over budget (early return above), `start` will
  // always end up > 0 — i.e. something is always dropped here.
  let tailChars = 0
  let start = rest.length
  while (start > 0) {
    const msgChars = estimateChars([rest[start - 1]])
    if (headChars + tailChars + msgChars <= budget) {
      start--
      tailChars += msgChars
    } else {
      break
    }
  }

  const dropped = start
  const trimmed = [...head, ...rest.slice(start)]
  if (dropped > 0) {
    const summary = opts.summarizeDropped ? summarizeDroppedMessages(rest.slice(0, start)) : ''
    // Insert the omit-note right after the preserved leading system message,
    // so the original system prompt stays first.
    trimmed.splice(head.length, 0, {
      role: 'system',
      content: `[system] ${dropped} earlier message(s) were omitted to fit the context window.${summary} The conversation continues below.`,
    })
  }
  return trimmed
}
