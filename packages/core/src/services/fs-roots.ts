/**
 * Filesystem sandbox roots — a Cordis service that holds the allowed root
 * directories for read / write / shell operations.
 *
 * Previously the roots were computed once at module load from `process.cwd()`
 * plus the `HARNESS_EXTRA_ROOTS` env var (see `fs-guard.ts`). That made the
 * sandbox location implicit and hard to pin down. This service centralizes the
 * resolved roots and lets a composition override them explicitly via the
 * manifest's top-level `fs:` key, e.g.
 *
 *   fs:
 *     readRoots:  [/path/to/workspace]
 *     writeRoots: [/path/to/workspace]
 *     shellRoots: [/path/to/workspace]
 *
 * When a list is omitted it falls back to the previous default:
 *   - read  → cwd + HARNESS_EXTRA_ROOTS
 *   - write → cwd
 *   - shell → cwd
 *
 * The service is auto-registered by the loader (so every composition has it),
 * which means the `fs:` key is optional — omit it and you get the old cwd-based
 * behavior.
 */

import { resolve } from 'node:path'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import {
  assertShellWithinRoots,
  assertWithinRoots,
  envExtraRoots,
  resolveRoots,
} from '../plugins/fs-guard.js'

declare module 'cordis' {
  interface Context {
    fsRoots: FsRootsService
  }
}

export interface FsRootsConfig {
  /** Explicit read roots. When set, replaces the cwd + HARNESS_EXTRA_ROOTS default. */
  readRoots?: string[]
  /** Explicit write roots. When set, replaces the cwd default. */
  writeRoots?: string[]
  /** Explicit shell roots. When set, replaces the cwd default. */
  shellRoots?: string[]
}

/**
 * Sanitize configured roots: strip entries that are useless or dangerous after
 * resolution.
 *  - Unexpanded `${ENV}` literals (a fresh checkout without the var set leaves
 *    the literal in place) are not real paths and would break the picker.
 *  - A bare filesystem root `/` is almost always an accident: a relative
 *    `../../..` anchor resolves to `/` when the cwd sits one level above the
 *    underlying mount point (e.g. container WORKDIR=/app with workspace at
 *    /workspace). Kept as-is it defeats every containment check via
 *    `startsWith(root + sep)` quirk, so drop it whenever a real root remains.
 *  - Duplicates (host `.env` and the relative anchor resolving to the same
 *    directory) only clutter the root view.
 * A lone `/` is kept unchanged: dropping it would empty the sandbox, and
 * nobody maps `readRoots: ['/']` deliberately.
 */
function sanitizeRoots(roots: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of roots) {
    const abs = resolve(r)
    if (abs.includes('${')) continue
    if (abs === '/' && out.length > 0) continue
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push(abs)
  }
  return out
}

export class FsRootsService extends Service {
  readonly read: string[]
  readonly write: string[]
  readonly shell: string[]

  constructor(ctx: Context, config: FsRootsConfig = {}) {
    super(ctx, 'fsRoots')
    this.read = config.readRoots?.length
      ? sanitizeRoots(config.readRoots)
      : resolveRoots({ extraRoots: envExtraRoots() })
    this.write = config.writeRoots?.length ? sanitizeRoots(config.writeRoots) : resolveRoots()
    this.shell = config.shellRoots?.length ? sanitizeRoots(config.shellRoots) : resolveRoots()
    ctx
      .logger('fs-roots')
      .info('sandbox roots — read=%s | write=%s | shell=%s', this.read, this.write, this.shell)
  }

  /** Throw unless `absPath` is inside the sandbox for the given operation. */
  assertWithin(absPath: string, kind: 'read' | 'write' | 'shell' = 'read'): void {
    assertWithinRoots(absPath, this[kind])
  }

  /** Throw unless the shell command stays inside the shell sandbox. */
  assertShellWithin(command: string): void {
    assertShellWithinRoots(command, this.shell)
  }
}
