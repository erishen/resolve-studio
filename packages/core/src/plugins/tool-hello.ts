/**
 * `hello` tool — exposes the @agent-harness/plugin-hello service to the agent.
 *
 * plugin-hello itself is a pure-Cordis service (`ctx.hello`) with no UI
 * presence: it lives in the runtime, logs heartbeats, and is callable by other
 * plugins. This tool wraps that service as a callable *tool*, so it shows up in
 * the web UI's tool list and the model can invoke it like any other tool —
 * making the previously invisible plugin visible end-to-end.
 */

import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

// Loose typing on purpose: the real `hello` service is declared inside
// @agent-harness/plugin-hello (a separate package); we only rely on its shape.
declare module 'cordis' {
  interface Context {
    hello?: { say(): string }
  }
}

const registerHello = (ctx: Context) => {
  ctx.tools.register({
    name: 'hello',
    description:
      'Say hello from the plugin-hello service. Demonstrates how a Cordis service (invisible to the UI) can be surfaced as a callable tool.',
    parameters: {
      type: 'object',
      properties: {
        greeting: { type: 'string', description: 'Optional custom greeting; defaults to the service greeting.' },
      },
    },
    async execute(args) {
      const custom = args['greeting'] ? String(args['greeting']) : ''
      const svc = ctx.hello
      if (!svc) return 'hello service is not loaded in this composition'
      return custom || svc.say()
    },
  } satisfies Tool)
}

export const toolHello = definePlugin(registerHello, 'tool-hello', ['tools', 'hello'])
