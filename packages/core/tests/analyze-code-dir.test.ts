/**
 * `analyze-code-dir` tool: composite code-directory analysis.
 *
 * In the test harness Serena is NOT connected, so the tool exercises its
 * transparent fallback to the raw `analyze-dir` walker. The test pins that
 * behaviour (mode: 'fallback-raw', real report returned) and the sandbox
 * guard. The Serena path itself is covered by manual/dev runs with Serena up.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { FsRootsService } from '../src/services/fs-roots.js'
import { toolAnalyzeDir } from '../src/plugins/tool-analyze-dir.js'
import { toolAnalyzeCodeDir } from '../src/plugins/tool-analyze-code-dir.js'

const ROOT = '.tmp-analyze-code'

async function seed(): Promise<void> {
  await mkdir(`${ROOT}/src`, { recursive: true })
  await mkdir(`${ROOT}/node_modules/foo`, { recursive: true })
  await writeFile(`${ROOT}/README.md`, '# demo\n\nsome project\n')
  await writeFile(`${ROOT}/src/index.ts`, 'export const x = 1\n')
  await writeFile(`${ROOT}/node_modules/foo/index.js`, 'module.exports = 1\n')
}

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(FsRootsService)
  await root.plugin(toolAnalyzeDir)
  await root.plugin(toolAnalyzeCodeDir)
  return root
}

test('analyze-code-dir falls back to raw walker when Serena is absent', async () => {
  await seed()
  const root = await buildContext()
  const out = await root.tools.call('analyze-code-dir', JSON.stringify({ dir: ROOT }))
  assert.ok(!String(out).startsWith('error:'), 'tool should not error')
  const report = JSON.parse(out as string)

  // No Serena in tests -> transparent fallback, still a useful report.
  assert.equal(report.mode, 'fallback-raw')
  assert.ok(report.summary, 'fallback merges the analyze-dir report')
  assert.match(report.tree ?? '', /README\.md/)
  assert.match(report.tree ?? '', /src\//)

  await rm(ROOT, { recursive: true, force: true })
  await root.fiber.dispose()
})

test('analyze-code-dir rejects paths outside the read sandbox', async () => {
  const root = await buildContext()
  const out = await root.tools.call('analyze-code-dir', JSON.stringify({ dir: '/etc' }))
  assert.match(out as string, /outside|sandbox|not a directory|cannot access/i)
  await root.fiber.dispose()
})
