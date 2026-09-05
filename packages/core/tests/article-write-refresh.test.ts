/**
 * article-write project enum refresh — regression: projects discovered by
 * article-discover at runtime must surface in the article-write tool's schema
 * enum and candidate list without a server restart.
 *
 * The old code read projects.json once at module-load and froze the enum; any
 * project added later by article-discover never appeared. The fix re-reads the
 * file on every execute() and updates the registered tool's `project` enum
 * in place (parameters are passed by reference to the LLM schema).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'

const TMP = mkdtempSync(join(tmpdir(), 'resolve-artw-'))

function makeProjectsDir(keys: string[]): string {
  const dir = join(TMP, `proj-${Math.random().toString(36).slice(2)}`)
  const taskDir = join(dir, 'tasks', 'project-articles')
  mkdirSync(taskDir, { recursive: true })
  const obj: Record<string, unknown> = {}
  for (const k of keys) obj[k] = { repo: `x/${k}`, desc: `desc ${k}`, highlights: 'h', source_dir: `src/${k}` }
  writeFileSync(join(taskDir, 'projects.json'), JSON.stringify(obj, null, 2))
  return dir
}

test('article-write picks up projects added by article-discover after registration', async () => {
  // First write a projects.json with one project, then the plugin will be
  // imported fresh (so its module-level keys come from this file).
  const dir = makeProjectsDir(['alpha'])
  process.env.CREWAI_PSE_DIR = dir

  const { toolArticleWrite } = await import('../src/plugins/tools/tool-article-write.js')
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(toolArticleWrite)

  // Schema enum starts with the registered project.
  const before = (root.tools.schemas().find((t) => t.name === 'article-write')?.parameters as {
    properties?: { project?: { enum?: string[] } }
  })?.properties?.project?.enum
  assert.deepEqual(before, ['alpha'])

  // Simulate article-discover appending two new projects to projects.json.
  const file = join(dir, 'tasks', 'project-articles', 'projects.json')
  const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  obj['beta'] = { repo: 'x/beta', desc: 'd', highlights: 'h', source_dir: 'src/beta' }
  obj['gamma'] = { repo: 'x/gamma', desc: 'd', highlights: 'h', source_dir: 'src/gamma' }
  writeFileSync(file, JSON.stringify(obj, null, 2))

  // Calling the tool (without project → returns the candidate list, no make
  // invocation) must reflect the two newly added projects.
  const result = await root.tools.call('article-write', {})
  assert.ok(result.includes('alpha'), 'existing project still present')
  assert.ok(result.includes('beta'), 'newly discovered beta appears in candidates')
  assert.ok(result.includes('gamma'), 'newly discovered gamma appears in candidates')

  // The registered schema enum is refreshed in place (same object the LLM schema
  // reads on the next turn), so a chained discover→write turn sees them too.
  const after = (root.tools.schemas().find((t) => t.name === 'article-write')?.parameters as {
    properties?: { project?: { enum?: string[] } }
  })?.properties?.project?.enum
  assert.deepEqual([...after!], ['alpha', 'beta', 'gamma'])

  await root.fiber.dispose()
  delete process.env.CREWAI_PSE_DIR
})

test('article-write rejects a project not in projects.json', async () => {
  const dir = makeProjectsDir(['alpha'])
  process.env.CREWAI_PSE_DIR = dir

  const { toolArticleWrite } = await import('../src/plugins/tools/tool-article-write.js')
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(toolArticleWrite)

  // A project not in the file must be rejected, even after a refresh.
  const result = await root.tools.call('article-write', { project: 'ghost' })
  assert.match(result, /unknown project "ghost"/)

  await root.fiber.dispose()
  delete process.env.CREWAI_PSE_DIR
})
