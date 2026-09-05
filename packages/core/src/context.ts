/**
 * Context window management.
 *
 * The agent loop historically sent the *entire* conversation to the model on
 * every turn. For long sessions that blows the context window (and the bill).
 * {@link fitContext} trims an over-budget conversation down to a contiguous
 * recent tail while keeping the leading system messages, and inserts a short
 * system note where content was dropped.
 *
 * Keeping a *contiguous* tail (rather than dropping individual old messages)
 * is deliberate: it preserves the adjacency between an assistant message that
 * issued tool calls and the tool-result messages that follow, so the model's
 * tool-call / result pairing never breaks. Trimming works on *rounds*: an
 * assistant message (with optional tool calls) plus any following tool-result
 * messages are an atomic unit, and units are only dropped from the front of the
 * older region — never split in the middle.
 *
 * When an LLM is available, {@link fitContextWithSummary} upgrades the terse
 * omit-note into a real rolling summary: the dropped region is compressed by
 * an extra, cheap (tool-free) model call, so long sessions keep a semantic
 * memory of earlier steps instead of just a list of tool names.
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
   * extra LLM summarization call.
   */
  summarizeDropped?: boolean
}

/** Options for the LLM-backed rolling-summary variant of {@link fitContext}. */
export interface FitWithSummaryOptions {
  maxChars?: number
  /**
   * When set, a within-budget input is returned AS-IS (no clone), and trimmed
   * output reuses the caller's message objects. Only safe when the caller owns
   * the array exclusively (e.g. the agent loop's private copy) — set this from
   * `agent.compact` to skip the per-iteration full-array clone.
   */
  reuseInPlace?: boolean
  /**
   * Compress a dropped message region into a short summary. Called by
   * {@link fitContextWithSummary}; may be an LLM chat call or any async
   * function. If it rejects or returns empty text, the terse omit-note
   * fallback (with tool-activity list) is used instead.
   */
  summarize: (dropped: ChatMessage[]) => Promise<string>
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
 * Split the non-system region into atomic *rounds*: an assistant message
 * (possibly carrying tool calls) followed by its tool-result messages, then a
 * user question, etc. This keeps an assistant’s tool_calls and the tool-result
 * messages that reply to them together forever — trimming never splits a round,
 * so the model's tool-call / result pairing cannot break.
 */
function splitRounds(msgs: ChatMessage[]): ChatMessage[][] {
  const rounds: ChatMessage[][] = []
  for (const m of msgs) {
    if (m.role === 'tool') {
      // Tool results always belong to the most recent assistant round (the
      // model only emits tool messages in reply to that round's tool calls).
      if (rounds.length && rounds[rounds.length - 1][0].role === 'assistant') {
        rounds[rounds.length - 1].push(m)
      } else {
        // Orphan tool message with no preceding assistant — keep as its own atom
        // rather than dropping context silently.
        rounds.push([m])
      }
    } else {
      rounds.push([m])
    }
  }
  return rounds
}

/** Circuit guard: never leave a tool-result message with no issuing assistant.
 *  A *mixed* round (`[tool]` alone, like a stranded tool reply with no prior
 *  assistant) is kept as its own atom so no context is silently dropped; the
 *  invalid case this catches is a round whose first message is `tool` yet also
 *  contains non-tool messages — that would mean a split landed mid-round. */
function assertRoundsIntact(rounds: ChatMessage[][]): void {
  for (const r of rounds) {
    if (r.length > 1 && r[0].role !== 'assistant' && r.some((m) => m.role === 'tool')) {
      throw new Error('invalid round split: mixed round not led by assistant')
    }
  }
}

/**
 * Shared trimming core: returns the retained leading system messages + the
 * contiguous recent tail (as rounds) of the non-system part. Returns
 * `{ head, rescued, rounds, start, tailChars }` where `start` is the index into
 * `rounds` at which the retained tail begins (rounds before it were dropped),
 * and `rescued` is an optional single round (the LAST user round) that was
 * dropped from the prefix but must be kept so the conversation still has a user
 * message when it is sent to an OpenAI-compatible endpoint.
 */
function trimToFit(
  messages: ChatMessage[],
  maxChars: number,
): {
  head: ChatMessage[]
  rescued: ChatMessage[]
  rounds: ChatMessage[][]
  start: number
  tailChars: number
} {
  const out = messages.map((m) => ({ ...m }))
  // ALL consecutive leading system messages are instructions and are kept
  // verbatim (env brief, skills index, caller/role system prompt). Earlier we
  // only kept the first system message, silently dropping the rest when the
  // state grew — that lost task instructions mid-run.
  let headEnd = 0
  while (headEnd < out.length && out[headEnd].role === 'system') headEnd++
  const head = out.slice(0, headEnd)
  const rounds = splitRounds(out.slice(headEnd))
  assertRoundsIntact(rounds)

  // Reserve room for the system note we may insert when something is dropped.
  const NOTE_RESERVE = 200
  const headChars = estimateChars(head)
  const budget = maxChars - NOTE_RESERVE

  // Keep a contiguous tail of rounds, shrinking from the front, until we fit.
  // Walking backward, adding whole rounds at a time keeps the tail within the
  // budget *and* round-atomic (never a partial tool-call pairing).
  let tailChars = 0
  let start = rounds.length
  while (start > 0) {
    const roundChars = estimateChars(rounds[start - 1])
    if (headChars + tailChars + roundChars <= budget) {
      start--
      tailChars += roundChars
    } else {
      break
    }
  }
  // INVARIANT: OpenAI-compatible chat endpoints reject a conversation with no
  // `user` message ("No user query found", HTTP 400). A long tool session can
  // push the original user question past the budget, leaving only assistant
  // + tool rounds in the tail. If that happened, rescue the LAST user round and
  // have the caller reinsert it right after the head (rounds are atomic, so
  // moving a whole user round never breaks a tool-call pairing). The dropped
  // middle rounds are still summarized by the caller.
  const rescued: ChatMessage[] = []
  let lastUser = -1
  for (let i = 0; i < rounds.length; i++) {
    if (rounds[i].some((m) => m.role === 'user')) lastUser = i
  }
  if (lastUser >= 0 && lastUser < start) {
    rescued.push(...rounds[lastUser])
  }
  return { head, rescued, rounds, start, tailChars }
}

/** Fallback omit-note text used when no LLM summary is available. */
function fallbackNote(
  dropped: number,
  droppedMsgs: ChatMessage[],
  summarizeDropped: boolean,
): string {
  const summary = summarizeDropped ? summarizeDroppedMessages(droppedMsgs) : ''
  return `[system] ${dropped} earlier round(s) were omitted to fit the context window.${summary} The conversation continues below.`
}

/**
 * Return a context-bounded copy of `messages`:
 *  - if already within budget, returns it unchanged;
 *  - otherwise keeps the leading system messages and a contiguous recent tail,
 *    dropping the middle and inserting a system note at the boundary.
 *
 * Dropped regions are whole rounds (assistant + its tool results), so tool-call
 * pairing never breaks. Leading system instructions are never dropped.
 */
export function fitContext(messages: ChatMessage[], opts: FitOptions = {}): ChatMessage[] {
  const maxChars = opts.maxChars ?? 60_000
  if (estimateChars(messages) <= maxChars) return messages.map((m) => ({ ...m }))

  const { head, rescued, rounds, start } = trimToFit(messages, maxChars)
  const common: ChatMessage[] = [...head]
  const tail: ChatMessage[] = []
  for (const r of rounds.slice(start)) tail.push(...r)
  // Reinsert the rescued user round (kept so the conversation always has a
  // user message) right after the leading system prompts.
  const trimmed = [...common, ...rescued, ...tail]
  if (start > 0) {
    const dropped: ChatMessage[] = []
    for (const r of rounds.slice(0, start)) dropped.push(...r)
    trimmed.splice(head.length, 0, {
      role: 'system',
      content: fallbackNote(start - (rescued.length ? 1 : 0), dropped, !!opts.summarizeDropped),
    })
  }
  return trimmed
}

/**
 * Async variant of {@link fitContext}: when messages are dropped, the dropped
 * region is first compressed by `opts.summarize` (an LLM-backed rolling
 * summary), and only falls back to the terse tool-activity note if that call
 * fails or yields nothing. Same contiguous-tail (round-atomic) trimming as the
 * sync version.
 */
export async function fitContextWithSummary(
  messages: ChatMessage[],
  opts: FitWithSummaryOptions,
): Promise<ChatMessage[]> {
  const maxChars = opts.maxChars ?? 60_000
  if (estimateChars(messages) <= maxChars) {
    // Caller-owned input: avoid a full-array + per-message clone on the hot path
    // (the agent compacts on every iteration). `reuseInPlace` is only safe when
    // the caller exclusively owns the array — see its doc comment.
    return opts.reuseInPlace ? messages : messages.map((m) => ({ ...m }))
  }

  const { head, rescued, rounds, start } = trimToFit(messages, maxChars)
  const common: ChatMessage[] = [...head]
  const tail: ChatMessage[] = []
  for (const r of rounds.slice(start)) tail.push(...r)
  const trimmed = [...common, ...rescued, ...tail]
  if (start > 0) {
    const dropped: ChatMessage[] = []
    for (const r of rounds.slice(0, start)) dropped.push(...r)
    const droppedRounds = start - (rescued.length ? 1 : 0)
    let note = ''
    try {
      const summary = await opts.summarize(dropped)
      if (summary) note = `[system] 先前 ${droppedRounds} 个轮次的摘要：${summary}`
    } catch {
      note = ''
    }
    if (!note) note = fallbackNote(droppedRounds, dropped, true)
    trimmed.splice(head.length, 0, { role: 'system', content: note })
  }
  return trimmed
}