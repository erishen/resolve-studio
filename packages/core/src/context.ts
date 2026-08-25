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
}

/**
 * Return a context-bounded copy of `messages`:
 *  - if already within budget, returns it unchanged;
 *  - otherwise keeps the first `system` message and a contiguous recent tail,
 *    dropping the middle and inserting a system note at the boundary.
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
  let start = 0
  while (start < rest.length) {
    const candidate = [...head, ...rest.slice(start)]
    const budget = start > 0 ? maxChars - NOTE_RESERVE : maxChars
    if (estimateChars(candidate) <= budget) break
    start += 1
  }

  const dropped = start
  const trimmed = [...head, ...rest.slice(start)]
  if (dropped > 0) {
    // Insert the omit-note right after the preserved leading system message,
    // so the original system prompt stays first.
    trimmed.splice(head.length, 0, {
      role: 'system',
      content: `[system] ${dropped} earlier message(s) were omitted to fit the context window. The conversation continues below.`,
    })
  }
  return trimmed
}
