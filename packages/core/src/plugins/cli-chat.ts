/**
 * CLI chat plugin — a tiny stdin REPL driven by the agent service.
 *
 * Listens for `agent/step` and `agent/done` to print progress as the loop runs,
 * reads a line at a time from stdin, and feeds it to `ctx.agent.run`. This is
 * the minimal "frontend" a DeepSeek-Harness-style composition needs; swapping
 * in a web/A2A frontend is just a different plugin on the same `ctx.agent`.
 */

import { stdin, stdout } from 'node:process'
import * as readline from 'node:readline'
import type { Context } from 'cordis'
import type { ChatMessage } from '../types.js'
import { definePlugin } from './util.js'

const startChat = (ctx: Context) => {
  const log = ctx.logger('cli')

  ctx.events.on('agent/tool-call', (call) => {
    const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
    stdout.write(`  → tool_call: ${call.name}(${args})\n`)
  })
  ctx.events.on('agent/tool-result', ({ call, result, ok }) => {
    stdout.write(`  ← ${call.name} => ${ok ? 'ok' : 'error'}: ${result}\n`)
  })

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity })
  const history: ChatMessage[] = []
  let busy = false

  const prompt = () => {
    if (!busy) stdout.write('\nagent> ')
  }

  const ask = async (text: string) => {
    busy = true
    history.push({ role: 'user', content: text })
    try {
      const answer = await ctx.agent.run({ messages: history })
      history.push({ role: 'assistant', content: answer })
      stdout.write(`\n${answer}\n`)
    } catch (err) {
      log.error('agent run failed: %s', (err as Error).message)
      stdout.write(`\n[error] ${(err as Error).message}\n`)
    } finally {
      busy = false
      prompt()
    }
  }

  log.info('agent REPL ready — type a message, or /exit to quit')
  prompt()

  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    if (text === '/exit' || text === '/quit') {
      rl.close()
      return
    }
    if (busy) return
    void ask(text)
  })

  rl.on('close', () => {
    log.info('bye')
    // Let any in-flight agent run finish before exiting (avoids cutting off
    // the streamed answer when stdin is closed while a request is pending).
    if (busy) {
      const wait = setInterval(() => {
        if (!busy) {
          clearInterval(wait)
          process.exit(0)
        }
      }, 50)
    } else {
      process.exit(0)
    }
  })
}

export const cliChat = definePlugin(startChat, 'cli-chat', ['agent'])
