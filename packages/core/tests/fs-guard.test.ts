import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertWithinRoots, assertShellWithinRoots, resolveRoots } from '../src/plugins/fs-guard.js'

test('resolveRoots defaults to cwd and appends extra roots', () => {
  assert.deepEqual(resolveRoots({ baseDir: '/app', extraRoots: ['/data'] }), ['/app', '/data'])
})

test('assertWithinRoots allows nested paths and blocks escapes', () => {
  const root = '/app'
  assert.doesNotThrow(() => assertWithinRoots('/app/foo/bar.txt', [root]))
  assert.doesNotThrow(() => assertWithinRoots('/app', [root]))
  assert.throws(() => assertWithinRoots('/app/../etc/passwd', [root]))
  assert.throws(() => assertWithinRoots('/etc/passwd', [root]))
})

test('assertShellWithinRoots allows in-root commands and blocks escapes', () => {
  const roots = ['/app']
  assert.doesNotThrow(() => assertShellWithinRoots('ls -la', roots))
  assert.doesNotThrow(() => assertShellWithinRoots('cat /app/x.txt', roots))
  assert.throws(() => assertShellWithinRoots('cat /etc/passwd', roots))
  assert.throws(() => assertShellWithinRoots('cd /app && rm ../../x', roots))
})
