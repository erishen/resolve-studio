/**
 * `fs-roots` service — config-driven sandbox roots with cwd-based defaults.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from 'cordis'
import { FsRootsService } from '../src/services/fs-roots.js'
import { loadConfig } from '../src/loader.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fs-roots-manifest.yml', import.meta.url))

const ROOT_A = '/tmp/fs-roots-a'
const ROOT_B = '/tmp/fs-roots-b'

test('explicit roots override the cwd-based defaults', async () => {
  const root = new Context()
  await root.plugin(FsRootsService, {
    readRoots: [ROOT_A],
    writeRoots: [ROOT_B],
    shellRoots: [ROOT_A],
  })

  assert.deepEqual(root.fsRoots.read, [resolve(ROOT_A)])
  assert.deepEqual(root.fsRoots.write, [resolve(ROOT_B)])
  assert.deepEqual(root.fsRoots.shell, [resolve(ROOT_A)])

  await root.fiber.dispose()
})

test('assertWithin / assertShellWithin enforce the configured sandbox', async () => {
  const root = new Context()
  await root.plugin(FsRootsService, {
    readRoots: [ROOT_A],
    writeRoots: [ROOT_A],
    shellRoots: [ROOT_A],
  })

  // Inside the sandbox: no throw.
  root.fsRoots.assertWithin(`${ROOT_A}/file.txt`, 'read')
  root.fsRoots.assertWithin(`${ROOT_A}/file.txt`, 'write')
  root.fsRoots.assertShellWithin(`cd ${ROOT_A} && ls`)

  // Outside the sandbox: throw.
  assert.throws(() => root.fsRoots.assertWithin('/etc/passwd', 'read'))
  assert.throws(() => root.fsRoots.assertShellWithin('cat /etc/passwd'))

  await root.fiber.dispose()
})

test('default roots fall back to cwd (read also honors HARNESS_EXTRA_ROOTS)', async () => {
  const root = new Context()
  await root.plugin(FsRootsService)
  assert.ok(root.fsRoots.read.includes(process.cwd()), 'read roots should include cwd')
  assert.deepEqual(root.fsRoots.write, [process.cwd()], 'write roots default to cwd only')
  assert.deepEqual(root.fsRoots.shell, [process.cwd()], 'shell roots default to cwd only')
  await root.fiber.dispose()
})

test('loader auto-registers fs-roots from a manifest (with optional fs: key)', async () => {
  const root = new Context()
  await loadConfig(root, FIXTURE)
  // The service must exist even though the fixture has no `fs:` block.
  assert.ok(root.fsRoots, 'fs-roots service should be auto-registered by the loader')
  assert.ok(root.fsRoots.read.includes(process.cwd()), 'default read roots include cwd')
  await root.fiber.dispose()
})
