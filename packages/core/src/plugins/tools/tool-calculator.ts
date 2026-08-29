/**
 * `calculator` tool — evaluates a simple arithmetic expression safely.
 *
 * Uses a hand-written shunting-yard evaluator over `+ - * / ( )` and numbers so
 * there is no `eval` of untrusted model output. Anything else is rejected.
 */

import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 }

function evaluate(expr: string): number {
  const tokens = expr.match(/-?\d+(?:\.\d+)?|[+\-*/()]|\S/g)
  if (!tokens) throw new Error('empty expression')
  if (/\S/.test(expr.replace(/[-0-9+*/().\s]/g, ''))) {
    throw new Error('only + - * / ( ) and numbers are allowed')
  }

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
    } else if (tok in PRECEDENCE) {
      while (
        ops.length &&
        ops[ops.length - 1] !== '(' &&
        PRECEDENCE[ops[ops.length - 1]!] >= PRECEDENCE[tok]
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
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('invalid expression')
  return result
}

const registerCalculator = (ctx: Context) => {
  ctx.tools.register({
    name: 'calculator',
    description: 'Evaluate a basic arithmetic expression, e.g. "(2 + 3) * 4".',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'The arithmetic expression to evaluate.' },
      },
      required: ['expression'],
    },
    async execute(args) {
      const expr = String(args['expression'] ?? '')
      return String(evaluate(expr))
    },
    needsApproval: false,
  } satisfies Tool)
}

export const toolCalculator = definePlugin(registerCalculator, 'tool-calculator', ['tools'])
