/**
 * `shell` tool — runs a command in the harness working directory (gated).
 *
 * Gives the agent the ability to run tests / builds / git commands, which
 * completes the "write code → verify" loop. Because arbitrary command
 * execution is powerful, it is flagged `needsApproval: true` — every command
 * must be approved by a human first.
 *
 * Guards:
 *  - 15s timeout (kills the process tree on expiry);
 *  - output truncated to 8 KiB so a chatty command can't flood the context;
 *  - runs with the same working directory / environment as the harness;
 *  - the approval gate is the primary safety boundary.
 */

import { exec } from 'node:child_process'
import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

const TIMEOUT_MS = 15_000
const MAX_OUTPUT = 8 * 1024

function runCommand(command: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    exec(command, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) {
        reject(err)
        return
      }
      // Non-zero exit codes are still useful output — hand both streams back.
      let out = stdout
      if (stderr) out += out ? `\n[stderr]\n${stderr}` : stderr
      if (err) out += `\n[exit code: ${typeof err.code === 'number' ? err.code : 'killed'}]`
      resolvePromise(out)
    })
  })
}

const registerShell = (ctx: Context) => {
  ctx.tools.register({
    name: 'shell',
    description:
      'Run a shell command in the harness working directory (15s timeout). Use to run tests, builds, or git commands. Requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute, e.g. "pnpm -C packages/core test".' },
      },
      required: ['command'],
    },
    async execute(args) {
      const command = String(args['command'] ?? '').trim()
      if (!command) throw new Error('command is required')
      if (command.length > 2000) throw new Error('command too long (max 2000 chars)')
      ctx.fsRoots.assertShellWithin(command)
      const raw = await runCommand(command)
      if (raw.length > MAX_OUTPUT) {
        return `${raw.slice(0, MAX_OUTPUT)}\n… [output truncated at ${MAX_OUTPUT} chars]`
      }
      return raw
    },
    needsApproval: true,
  } satisfies Tool)
}

export const toolShell = definePlugin(registerShell, 'tool-shell', ['tools', 'fsRoots'])
