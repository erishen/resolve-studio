/**
 * `echo` tool — repeats back the text it was given.
 *
 * A trivial tool that still exercises the full tool-call path, so the agent
 * loop can be demonstrated offline (pair it with the `llm-mock` adapter).
 */

import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

const registerEcho = (ctx: Context) => {
  ctx.tools.register({
    name: 'echo',
    description: 'Echo the provided text back to the caller.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to echo.' },
      },
      required: ['text'],
    },
    async execute(args) {
      return String(args['text'] ?? '')
    },
  } satisfies Tool)
}

export const toolEcho = definePlugin(registerEcho, 'tool-echo', ['tools'])
