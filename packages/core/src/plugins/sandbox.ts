/**
 * Sandbox service — isolates tool execution at the OS level.
 *
 * Strategy (mirrors resolve-tui):
 *   - macOS: `/usr/bin/sandbox-exec` with a generated Seatbelt profile
 *     (deny default → allow read → allow write only on whitelisted roots →
 *     optional network).
 *   - Linux: `bwrap` (bubblewrap) if available, else direct exec with warning.
 *   - Other platforms / sandbox binary missing: degrade to direct exec with
 *     a one-time warning.
 *
 * This is a true OS sandbox (not just path-string matching): the kernel
 * enforces the policy, so even a crafted command can't write outside the
 * whitelisted roots or touch the network when network is denied.
 *
 * Configuration (env):
 *   SANDBOX_ENABLED=true|false   — master switch (default: false)
 *   SANDBOX_ALLOW_NETWORK=true|false — whether sandboxed processes may use the
 *                                       network (default: true)
 */

import { existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { definePlugin } from './util.js'

declare module 'cordis' {
  interface Context {
    sandbox: SandboxService
  }
}

export interface SandboxConfig {
  enabled?: boolean
  allowNetwork?: boolean
  /** Extra writable roots beyond cwd + tmpdir. */
  writableRoots?: string[]
}

interface SandboxBinary {
  cmd: string
  args: string[]
}

export class SandboxService extends Service {
  readonly enabled: boolean
  readonly allowNetwork: boolean
  readonly writableRoots: string[]
  private readonly seatbeltProfiles = new Map<string, string>()
  private warnedDegraded = false

  constructor(ctx: Context, config: SandboxConfig = {}) {
    super(ctx, 'sandbox')
    this.enabled = config.enabled ?? process.env.SANDBOX_ENABLED === 'true'
    this.allowNetwork = config.allowNetwork ?? process.env.SANDBOX_ALLOW_NETWORK !== 'false'
    const base = resolve(process.cwd())
    const tmp = resolve(tmpdir())
    const extras = (config.writableRoots ?? []).map((r) => resolve(r))
    // Deduplicate while preserving order.
    this.writableRoots = [...new Set([base, tmp, ...extras])]
    ctx
      .logger('sandbox')
      .info(
        'sandbox %s (network=%s, writable=%s)',
        this.enabled ? 'enabled' : 'disabled',
        this.allowNetwork ? 'on' : 'off',
        this.writableRoots.join(', '),
      )
  }

  /**
   * Wrap a command+args for sandboxed execution. Returns the binary and args
   * to spawn. When sandbox is disabled or the platform binary is missing,
   * returns the original command unchanged (with a one-time warning).
   */
  wrap(program: string, args: string[]): SandboxBinary {
    if (!this.enabled) return { cmd: program, args }

    if (process.platform === 'darwin') {
      return this.wrapSeatbelt(program, args)
    }

    if (process.platform === 'linux') {
      return this.wrapBwrap(program, args)
    }

    this.warnDegraded(`platform ${process.platform} not supported`)
    return { cmd: program, args }
  }

  /** Wrap a shell command string (e.g. "pnpm test") for sandboxed execution. */
  wrapShell(command: string, opts: { writableRoots?: string[] } = {}): SandboxBinary {
    // On Unix, spawn with shell:true uses /bin/sh -c <command>.
    // We need to wrap the shell itself, not the command.
    if (!this.enabled) return { cmd: command, args: [] }
    // Per-run writable roots (e.g. a background job's workspace) extend the
    // base set (cwd + tmpdir + configured extras) without mutating it.
    const roots = opts.writableRoots?.length
      ? [...new Set([...this.writableRoots, ...opts.writableRoots.map((r) => resolve(r))])]
      : this.writableRoots
    // For shell mode, we pass the command as a single arg to sh -c.
    // The sandbox binary wraps /bin/sh, and -c <command> follows.
    if (process.platform === 'darwin') {
      const profile = this.ensureSeatbeltProfile(roots)
      return {
        cmd: '/usr/bin/sandbox-exec',
        args: ['-f', profile, '/bin/sh', '-c', command],
      }
    }
    if (process.platform === 'linux' && existsSync('/usr/bin/bwrap')) {
      return this.wrapBwrap('/bin/sh', ['-c', command], roots)
    }
    this.warnDegraded('sandbox binary not found')
    return { cmd: command, args: [] }
  }

  // ---- macOS Seatbelt ----

  private wrapSeatbelt(program: string, args: string[]): SandboxBinary {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      this.warnDegraded('sandbox-exec not found')
      return { cmd: program, args }
    }
    const profile = this.ensureSeatbeltProfile()
    return { cmd: '/usr/bin/sandbox-exec', args: ['-f', profile, program, ...args] }
  }

  private ensureSeatbeltProfile(roots: string[] = this.writableRoots): string {
    // Profiles are cached per root-set so per-run workspaces don't churn the
    // filesystem with a fresh profile on every tool call.
    const key = roots.join('\n')
    const cached = this.seatbeltProfiles.get(key)
    if (cached) return cached
    // Generate a Seatbelt profile: deny default, allow read, allow write only
    // on whitelisted roots, optional network.
    let sb = '(version 1)\n'
    sb += '(deny default)\n'
    // Basic process / IPC permissions needed for most Unix tools.
    sb += '(allow process*)\n'
    sb += '(allow mach-lookup)\n'
    sb += '(allow sysctl*)\n'
    sb += '(allow iokit-open)\n'
    sb += '(allow file-read*)\n'
    sb += '(deny file-write*)\n'
    // Character devices: shell redirects (`2>&1`, `>/dev/null`) and RNG/TTY
    // access need data writes to /dev even though it is outside writable
    // roots — without this, EVERY redirecting command dies with
    // "/dev/null: Operation not permitted". data-only grants (no create).
    sb +=
      '(allow file-write-data\n' +
      '  (literal "/dev/null")\n' +
      '  (literal "/dev/zero")\n' +
      '  (literal "/dev/random")\n' +
      '  (literal "/dev/urandom")\n' +
      '  (literal "/dev/tty")\n' +
      '  (literal "/dev/dtracehelper"))\n'
    for (const root of roots) {
      // Use literal path; Seatbelt matches subpath.
      sb += `(allow file-write* (subpath "${root}"))\n`
    }
    if (this.allowNetwork) {
      sb += '(allow network*)\n'
      sb += '(allow system-socket)\n'
    }
    const dir = mkdtempSync(join(tmpdir(), 'resolve-studio-sb-'))
    const profilePath = join(dir, 'profile.sb')
    writeFileSync(profilePath, sb, 'utf8')
    this.seatbeltProfiles.set(key, profilePath)
    this.ctx.logger('sandbox').info('seatbelt profile written to %s', profilePath)
    return profilePath
  }

  // ---- Linux bubblewrap ----

  private wrapBwrap(
    program: string,
    args: string[],
    roots: string[] = this.writableRoots,
  ): SandboxBinary {
    if (!existsSync('/usr/bin/bwrap')) {
      this.warnDegraded('bwrap not found')
      return { cmd: program, args }
    }
    const bwrapArgs = [
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--die-with-parent',
    ]
    for (const root of roots) {
      bwrapArgs.push('--bind', root, root)
    }
    if (!this.allowNetwork) {
      bwrapArgs.push('--unshare-net')
    }
    return { cmd: '/usr/bin/bwrap', args: [...bwrapArgs, program, ...args] }
  }

  private warnDegraded(reason: string): void {
    if (this.warnedDegraded) return
    this.warnedDegraded = true
    this.ctx.logger('sandbox').warn('sandbox degraded to direct exec: %s', reason)
  }
}

export const sandbox = definePlugin(SandboxService, 'sandbox', [])
