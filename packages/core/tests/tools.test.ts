/**
 * Tool tests: file read/write, shell, calculator, echo — happy paths plus
 * guard rails (binary detection, missing files, non-zero exits, bad input).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { FsRootsService } from '../src/services/fs-roots.js'
import { toolReadFile } from '../src/plugins/tools/tool-read-file.js'
import { toolWriteFile } from '../src/plugins/tools/tool-write-file.js'
import { toolShell } from '../src/plugins/tools/tool-shell.js'
import { sandbox } from '../src/plugins/sandbox.js'
import { toolCalculator } from '../src/plugins/tools/tool-calculator.js'
import { toolEcho } from '../src/plugins/tools/tool-echo.js'

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(FsRootsService)
  await root.plugin(sandbox)
  await root.plugin(toolReadFile)
  await root.plugin(toolWriteFile)
  await root.plugin(toolShell)
  await root.plugin(toolCalculator)
  await root.plugin(toolEcho)
  return root
}

test('read-file reads text and rejects binary / missing files', async () => {
  const root = await buildContext()
  const self = await root.tools.call(
    'read-file',
    JSON.stringify({ path: 'src/plugins/tools/tool-read-file.ts' }),
  )
  assert.match(self, /`read-file` tool/, 'expected source text in the reply')
  assert.match(self, /bytes 0\.\./, 'expected the slice-range header')

  const missing = await root.tools.call('read-file', JSON.stringify({ path: 'no-such-file.ts' }))
  assert.match(missing, /^error:/)

  await writeFile('.tmp-binary.bin', Buffer.from([1, 2, 0, 3]))
  const bin = await root.tools.call('read-file', JSON.stringify({ path: '.tmp-binary.bin' }))
  assert.match(bin, /binary/)
  await rm('.tmp-binary.bin', { force: true })

  await root.fiber.dispose()
})

test('write-file writes content and creates parent directories', async () => {
  const root = await buildContext()
  const tmpDir = resolve(process.cwd(), '.tmp-write')
  const absPath = resolve(tmpDir, 'a/b.txt')
  const res = await root.tools.call(
    'write-file',
    JSON.stringify({ path: absPath, content: 'hello write' }),
  )
  assert.match(res, /wrote 11 chars/)

  const readBack = await root.tools.call('read-file', JSON.stringify({ path: absPath }))
  assert.match(readBack, /hello write/)

  // Large-file slicing: page through a file bigger than one slice, then past
  // the end.
  const big = resolve(tmpDir, 'big.txt')
  await writeFile(big, 'a'.repeat(200_000))
  const first = await root.tools.call('read-file', JSON.stringify({ path: big, limit: 64 * 1024 }))
  assert.match(first, /bytes 0..65536/, 'first slice range reported')
  const second = await root.tools.call(
    'read-file',
    JSON.stringify({ path: big, offset: 65536, limit: 65536 }),
  )
  assert.match(second, /bytes 65536\.\.131072/, 'second slice range reported')
  const pastEnd = await root.tools.call(
    'read-file',
    JSON.stringify({ path: big, offset: 1_000_000 }),
  )
  assert.match(pastEnd, /已到文件末尾/, 'read past EOF reports the end')

  await rm(tmpDir, { recursive: true, force: true })
  await root.fiber.dispose()
})

test('shell runs commands and reports non-zero exit', async () => {
  const root = await buildContext()
  const pwd = await root.tools.call('shell', JSON.stringify({ command: 'pwd' }))
  assert.ok(pwd.includes('resolve-studio'), 'expected cwd in output')

  const failed = await root.tools.call('shell', JSON.stringify({ command: 'exit 3' }))
  assert.match(failed, /^error:/)

  const empty = await root.tools.call('shell', JSON.stringify({ command: '' }))
  assert.match(empty, /^error:/)

  await root.fiber.dispose()
})

test('calculator evaluates safely and rejects junk', async () => {
  const root = await buildContext()
  assert.equal(
    await root.tools.call('calculator', JSON.stringify({ expression: '(2 + 3) * 4' })),
    '20',
  )
  assert.equal(await root.tools.call('calculator', JSON.stringify({ expression: '10 / 4' })), '2.5')

  const junk = await root.tools.call('calculator', JSON.stringify({ expression: '2 + junk' }))
  assert.match(junk, /^error:/)

  await root.fiber.dispose()
})

test('echo returns the input text', async () => {
  const root = await buildContext()
  assert.equal(await root.tools.call('echo', JSON.stringify({ text: 'hi' })), 'hi')
  await root.fiber.dispose()
})

test('tools.call honors { internal: true } and surfaces it on the event', async () => {
  const root = await buildContext()
  let seen: { name: string; internal?: boolean } | null = null
  root.on('tools/call', (p: { name: string; internal?: boolean }) => {
    seen = p
  })
  const res = await root.tools.call('echo', JSON.stringify({ text: 'hi' }), { internal: true })
  assert.equal(res, 'hi')
  assert.ok(seen, 'tools/call event should fire')
  assert.equal(seen?.name, 'echo')
  assert.equal(seen?.internal, true, 'internal flag should be forwarded to the event')
  await root.fiber.dispose()
})
