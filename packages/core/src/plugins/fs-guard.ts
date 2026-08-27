/**
 * Filesystem sandbox guards.
 *
 * The harness runs with the *resolve-studio* directory as its working root.
 * File tools (read-file / write-file) must never escape that root, and the
 * shell tool must not be steered at paths outside it. These helpers enforce a
 * "stay inside the sandbox" boundary so a stray or adversarial tool call can't
 * read or overwrite arbitrary files on the disk.
 *
 * The boundary is conservative but not a true OS sandbox: it is a friction
 * layer *on top of* the human-approval gate, not a replacement for it.
 */

import { resolve, sep } from 'node:path'

/** Parse `HARNESS_EXTRA_ROOTS` (colon-separated) for read-only access to
 *  sibling projects (e.g. the autogen-pse task dir) without opening the whole
 *  filesystem. Write/shell stay limited to the base root. */
export function envExtraRoots(): string[] {
  const raw = process.env['HARNESS_EXTRA_ROOTS']
  if (!raw) return []
  return raw
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Resolve the allowed root directories. `baseDir` defaults to cwd. */
export function resolveRoots(opts: { baseDir?: string; extraRoots?: string[] } = {}): string[] {
  const base = resolve(opts.baseDir ?? process.cwd())
  const extras = (opts.extraRoots ?? []).map((r) => resolve(r))
  return [base, ...extras]
}

/** Throw if `absPath` is not contained within any of `roots`. */
export function assertWithinRoots(absPath: string, roots: string[]): void {
  const target = resolve(absPath)
  const ok = roots.some((r) => {
    const root = resolve(r)
    return target === root || target.startsWith(root + sep)
  })
  if (!ok) {
    throw new Error(`path escapes the allowed sandbox (${target}); operation blocked`)
  }
}

/**
 * Best-effort guard for shell commands. Rejects commands that reference an
 * absolute path outside the allowed roots, or that use `..` parent traversal
 * (which would let a command leave the working root). This is not a true
 * sandbox; it is a friction layer on top of the approval gate.
 *
 * Set `HARNESS_SHELL_ALLOW_TRAVERSAL=1` to relax the `..` check (still blocks
 * absolute escapes) — e.g. when a trusted command legitimately needs `..`.
 */
export function assertShellWithinRoots(command: string, roots: string[]): void {
  // 1) Reject absolute-path tokens that land outside the roots.
  const absTokenRe = /(?:^|[\s'"])((\/|[A-Za-z]:\\)[^\s'"]*)/g
  let m: RegExpExecArray | null
  while ((m = absTokenRe.exec(command)) !== null) {
    const p = m[1]
    try {
      assertWithinRoots(p, roots)
    } catch {
      throw new Error(`shell command references a path outside the sandbox: ${p}`)
    }
  }
  // 2) Reject parent-directory traversal unless explicitly relaxed.
  if (!process.env['HARNESS_SHELL_ALLOW_TRAVERSAL'] && command.includes('..')) {
    throw new Error(
      'shell command contains ".." path traversal; blocked for safety (set HARNESS_SHELL_ALLOW_TRAVERSAL=1 to allow)',
    )
  }
}

/** Roots used for read operations (base + configured extra read-only roots). */
export const READ_ROOTS = resolveRoots({ extraRoots: envExtraRoots() })
/** Roots used for write operations (base only — writes never escape). */
export const WRITE_ROOTS = resolveRoots()
/** Roots the shell is allowed to touch (base only). */
export const SHELL_ROOTS = resolveRoots()
