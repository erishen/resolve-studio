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
 *     readRoots:  [WORKSPACE]
 *     writeRoots: [WORKSPACE]
 *     shellRoots: [WORKSPACE]
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

export class FsRootsService extends Service {
  readonly read: string[]
  readonly write: string[]
  readonly shell: string[]

  constructor(ctx: Context, config: FsRootsConfig = {}) {
    super(ctx, 'fsRoots')
    this.read = config.readRoots?.length
      ? config.readRoots.map((r) => resolve(r))
      : resolveRoots({ extraRoots: envExtraRoots() })
    this.write = config.writeRoots?.length
      ? config.writeRoots.map((r) => resolve(r))
      : resolveRoots()
    this.shell = config.shellRoots?.length
      ? config.shellRoots.map((r) => resolve(r))
      : resolveRoots()
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
