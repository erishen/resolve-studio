/**
 * `shell` tool — runs a command in the harness working directory (gated).
 *
 * Gives the agent the ability to run tests / builds / git commands, which
 * completes the "write code → verify" loop. Because arbitrary command
 * execution is powerful, it is flagged `needsApproval: true` — every command
 * must be approved by a human first.
 *
 * Guards:
 *  - 15s timeout (kills the entire process tree on expiry via process group);
 *  - output truncated to 8 KiB so a chatty command can't flood the context;
 *  - runs with the same working directory / environment as the harness;
 *  - the approval gate is the primary safety boundary.
 *
 * Implementation note: uses `spawn` with `shell: true` + `detached: true`
 * instead of `exec`. `exec`'s built-in timeout only signals the shell itself,
 * leaving grandchildren (e.g. `npm test` → jest workers) orphaned and still
 * running. `detached: true` puts the child in its own process group, so
 * `process.kill(-pid)` can reap the whole tree.
 */

import { spawn } from 'node:child_process'
import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const TIMEOUT_MS = 15_000
const MAX_OUTPUT = 8 * 1024

interface SpawnTarget {
  cmd: string
  args: string[]
  shell: boolean
}

function runCommand(target: SpawnTarget): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // When sandboxed, `target.cmd` is sandbox-exec/bwrap and `target.args`
    // includes the full wrapped command line — spawn without shell. When not
    // sandboxed, keep `shell: true` for pipelines/redirects.
    const child = spawn(target.cmd, target.args, {
      shell: target.shell,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      const text = chunk.toString()
      if (target === 'stdout') stdout += text
      else stderr += text
    }
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'))

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Match the original `exec` behavior: a failed command with no stdout or
      // stderr is rejected (ToolRegistry then wraps it as "error: …"), while a
      // failed command that produced output is resolved with the output plus an
      // exit-code note so the model can see what happened.
      if (exitCode !== null && exitCode !== 0 && !stdout && !stderr) {
        reject(new Error(`Command failed with exit code ${exitCode}`))
        return
      }
      let out = stdout
      if (stderr) out += out ? `\n[stderr]\n${stderr}` : stderr
      if (exitCode !== null && exitCode !== 0) out += `\n[exit code: ${exitCode}]`
      else if (signal) out += `\n[killed by signal: ${signal}]`
      resolvePromise(out)
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code, signal) => finish(code, signal))

    const timer = setTimeout(() => {
      if (settled) return
      // Kill the entire process group (negative pid) so grandchildren are
      // reaped too. SIGTERM first; if the process group ignores it, the
      // child's `close` event may never fire — fall back to SIGKILL after
      // a short grace period.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* process already gone */
      }
      setTimeout(() => {
        if (settled) return
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
        // Force-resolve with whatever output we have so the tool call can't
        // hang forever if the process group ignores both signals.
        finish(null, 'SIGKILL')
      }, 2000).unref()
    }, TIMEOUT_MS)
    timer.unref()
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
        command: {
          type: 'string',
          description: 'The shell command to execute, e.g. "pnpm -C packages/core test".',
        },
      },
      required: ['command'],
    },
    async execute(args) {
      const command = String(args['command'] ?? '').trim()
      if (!command) throw new Error('command is required')
      if (command.length > 2000) throw new Error('command too long (max 2000 chars)')
      ctx.fsRoots.assertShellWithin(command)
      // Wrap for OS-level sandbox if enabled. When sandboxed, we get an
      // explicit {cmd, args} target (sandbox-exec -f profile /bin/sh -c ...);
      // otherwise fall back to shell:true mode.
      const target: SpawnTarget = ctx.sandbox?.enabled
        ? { ...ctx.sandbox.wrapShell(command), shell: false }
        : { cmd: command, args: [], shell: true }
      const raw = await runCommand(target)
      if (raw.length > MAX_OUTPUT) {
        return `${raw.slice(0, MAX_OUTPUT)}\n… [output truncated at ${MAX_OUTPUT} chars]`
      }
      return raw
    },
    needsApproval: true,
  } satisfies Tool)
}

export const toolShell = definePlugin(registerShell, 'tool-shell', ['tools', 'fsRoots', 'sandbox'])
