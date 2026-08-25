/**
 * Fast Path service — deterministic pre-processing before the LLM loop.
 *
 * Mirrors the spirit of resolve-harness' Fast Path: anything we can compute
 * with pure code should never reach the model. If `tryResolve` returns a
 * non-null string the agent loop short-circuits and returns it directly,
 * costing zero model calls.
 *
 * This is intentionally small (arithmetic only for now) and fully offline.
 * It is a *guard*, not a replacement for tools: the `calculator` tool still
 * exists for the model to use on its own. Fast Path just answers the common
 * "what is 3+4" class of queries without spinning up a model round-trip.
 */

import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    fastpath: FastPathService
  }
}

// Allowed arithmetic characters. Anything outside this set means "not a pure
// arithmetic query" and we bail out, letting the model handle it.
const SAFE_ARITHMETIC = /^[0-9+\-*/().\s]+$/

// A shunting-yard evaluator over + - * / ( ) and decimal numbers. Same idea as
// the calculator tool, kept local so Fast Path has zero coupling to it.
function evalArithmetic(expr: string): number {
  const tokens = expr.match(/-?\d+(?:\.\d+)?|[+\-*/()]|\S/g)
  if (!tokens) throw new Error('empty expression')
  if (/\S/.test(expr.replace(/[-0-9+*/().\s]/g, ''))) {
    throw new Error('unsupported character')
  }

  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }
  const output: (number | string)[] = []
  const ops: string[] = []
  const apply = (op: string) => {
    const b = output.pop() as number
    const a = output.pop() as number
    output.push(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : a / b)
  }

  for (const tok of tokens) {
    if (/^-?\d+(?:\.\d+)?$/.test(tok)) {
      output.push(parseFloat(tok))
    } else if (tok === '(') {
      ops.push(tok)
    } else if (tok === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') apply(ops.pop()!)
      if (ops.pop() !== '(') throw new Error('mismatched parentheses')
    } else if (tok in precedence) {
      while (
        ops.length &&
        ops[ops.length - 1] !== '(' &&
        precedence[ops[ops.length - 1]!] >= precedence[tok]
      ) {
        apply(ops.pop()!)
      }
      ops.push(tok)
    } else {
      throw new Error(`unexpected token "${tok}"`)
    }
  }
  while (ops.length) apply(ops.pop()!)
  const result = output[0] as number
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('invalid expression')
  }
  return result
}

export class FastPathService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fastpath')
  }

  /**
   * Attempt to resolve `text` deterministically.
   *
   * Returns the computed answer as a string, or `null` if the input is not a
   * pure arithmetic query we can handle offline.
   */
  tryResolve(text: string): string | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    // Must be entirely arithmetic characters; otherwise let the model decide.
    if (!SAFE_ARITHMETIC.test(trimmed)) return null
    try {
      const value = evalArithmetic(trimmed)
      return String(value)
    } catch {
      return null
    }
  }
}
