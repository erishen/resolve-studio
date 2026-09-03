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
    const args =
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)
    stdout.write(`  → tool_call: ${call.name}(${args})\n`)
  })
  ctx.events.on('agent/tool-result', ({ call, result, ok }) => {
    stdout.write(`  ← ${call.name} => ${ok ? 'ok' : 'error'}: ${result}\n`)
  })

  const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity })
  const history: ChatMessage[] = []
  let busy = false
  let currentRun: AbortController | null = null

  const prompt = () => {
    if (!busy) stdout.write('\nagent> ')
  }

  const ask = async (text: string) => {
    busy = true
    history.push({ role: 'user', content: text })
    const ac = new AbortController()
    currentRun = ac
    try {
      const answer = await ctx.agent.run({ messages: history, signal: ac.signal })
      history.push({ role: 'assistant', content: answer })
      stdout.write(`\n${answer}\n`)
    } catch (err) {
      log.error('agent run failed: %s', (err as Error).message)
      stdout.write(`\n[error] ${(err as Error).message}\n`)
    } finally {
      currentRun = null
      busy = false
      prompt()
    }
  }

  // One Ctrl+C must exit the CLI — no second press. The terminal already sends
  // SIGINT to the whole process group (spawned tool children included), so a
  // hard exit here is safe; the in-flight run is aborted as best-effort so any
  // abort-aware child (e.g. the LLM call) unwinds instead of hanging the exit.
  const onSigint = () => {
    stdout.write('\n')
    log.info('interrupted — exiting')
    currentRun?.abort()
    process.exit(130)
  }
  process.on('SIGINT', onSigint)

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
    // (Ctrl+C takes the immediate-exit path above via onSigint, not this one.)
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

  // Disposer: drop the global SIGINT listener so repeated plugin start/stop
  // cycles (tests) don't leak listeners or swallow Ctrl+C for unrelated code.
  return () => {
    process.off('SIGINT', onSigint)
  }
}

export const cliChat = definePlugin(startChat, 'cli-chat', ['agent'])
