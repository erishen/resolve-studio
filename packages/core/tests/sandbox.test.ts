/**
 * `sandbox` service — Seatbelt profile regression guards.
 *
 * Two friction points these lock down:
 * 1. /dev character devices MUST be writable (data-only). Without
 *    `file-write-data` on /dev/null, every shell command using a redirect
 *    (`2>&1`, `>/dev/null`) dies with "Operation not permitted" — this
 *    silently broke the `make check-links` example task.
 * 2. Writable roots stay limited to cwd + tmpdir (+ configured extras);
 *    the profile must NOT open blanket writes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { SandboxService } from '../src/plugins/sandbox.js'

function seatbeltProfile(svc: SandboxService): string {
  // private-by-type but reachable at runtime; tests assert the generated text.
  const gen = (svc as unknown as { ensureSeatbeltProfile(): string }).ensureSeatbeltProfile.bind(svc)
  return readFileSync(gen(), 'utf8')
}

test('seatbelt profile allows data writes to /dev character devices', async () => {
  const root = new Context()
  await root.plugin(SandboxService, { enabled: true })
  const profile = seatbeltProfile(root.sandbox)

  assert.match(profile, /\(allow file-write-data/)
  for (const dev of ['/dev/null', '/dev/zero', '/dev/urandom']) {
    assert.ok(profile.includes(`(literal "${dev}")`), `profile should allow writing ${dev}`)
  }
  // Grant is data-only — must not be blanket file-write* on /dev.
  assert.ok(!profile.includes('(subpath "/dev")'), '/dev must not be fully writable')

  await root.fiber.dispose()
})

test('seatbelt profile confines writes to cwd + tmpdir (+extras) and keeps read-all', async () => {
  const root = new Context()
  await root.plugin(SandboxService, { enabled: true, writableRoots: ['/tmp/sbx-extra-root'] })
  const profile = seatbeltProfile(root.sandbox)

  assert.match(profile, /\(allow file-read\*\)/)
  assert.match(profile, /\(deny file-write\*\)/)
  assert.ok(profile.includes(`(subpath "${resolve(process.cwd())}")`), 'cwd must stay writable')
  assert.ok(profile.includes('(subpath "/tmp/sbx-extra-root")'), 'extra root must be granted')

  await root.fiber.dispose()
})
