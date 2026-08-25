/**
 * `analyze-dir` tool: recursive scan + structured report, with sandbox bounds
 * and junk-dir / binary skipping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { FsRootsService } from '../src/services/fs-roots.js'
import { toolAnalyzeDir } from '../src/plugins/tool-analyze-dir.js'

const ROOT = '.tmp-analyze'

async function seed(): Promise<void> {
  await mkdir(`${ROOT}/src`, { recursive: true })
  await mkdir(`${ROOT}/node_modules/foo`, { recursive: true })
  await mkdir(`${ROOT}/.git`, { recursive: true })
  await writeFile(`${ROOT}/README.md`, '# demo\n\nsome project\n')
  await writeFile(`${ROOT}/src/index.ts`, 'export const x = 1\n')
  await writeFile(`${ROOT}/node_modules/foo/index.js`, 'module.exports = 1\n')
  await writeFile(`${ROOT}/.git/config`, '[core]\n')
  await writeFile(`${ROOT}/img.bin`, Buffer.from([1, 2, 0, 3]))
}

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(FsRootsService)
  await root.plugin(toolAnalyzeDir)
  return root
}

test('analyze-dir returns a structured report and skips junk dirs / binaries', async () => {
  await seed()
  const root = await buildContext()
  const out = await root.tools.call('analyze-dir', JSON.stringify({ dir: ROOT }))
  const report = JSON.parse(out as string)

  // Real files counted; node_modules/ and .git/ skipped entirely.
  assert.equal(report.summary.totalFiles, 3, 'README + src/index.ts + img.bin (junk dirs excluded)')
  assert.equal(report.summary.totalDirs, 1, 'only the src/ directory')
  assert.equal(report.summary.truncated, false)

  // Tree must list the real files/dirs but NOT node_modules or .git.
  assert.match(report.tree, /README\.md/)
  assert.match(report.tree, /src\//)
  assert.match(report.tree, /index\.ts/)
  assert.match(report.tree, /img\.bin/)
  assert.doesNotMatch(report.tree, /node_modules/)
  assert.doesNotMatch(report.tree, /\.git/)

  // Snippets present for text files, empty for the binary.
  const readme = report.files.find((f: { path: string }) => f.path === 'README.md')
  const binary = report.files.find((f: { path: string }) => f.path === 'img.bin')
  assert.ok(readme && readme.snippet.includes('some project'), 'text snippet captured')
  assert.equal(binary.snippet, '', 'binary snippet left empty')

  await rm(ROOT, { recursive: true, force: true })
  await root.fiber.dispose()
})

test('analyze-dir rejects paths outside the read sandbox', async () => {
  const root = await buildContext()
  const out = await root.tools.call('analyze-dir', JSON.stringify({ dir: '/etc' }))
  assert.match(out as string, /outside|sandbox|not a directory|cannot access/i)
  await root.fiber.dispose()
})
