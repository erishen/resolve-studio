/**
 * crewai-publish project enum refresh — regression: projects queued while the
 * process is running must surface in article-validate / article-publish /
 * article-archive without a server restart.
 *
 * The old code computed the key list once in `registerCrewAiPublish` and baked
 * it into the schema `enum`, so anything added later stayed invisible for the
 * whole session (sprite was missing until the process restarted: both its
 * projects.json entry and its article file landed after startup).
 *
 * The fix builds `parameters` through a getter and re-reads the keys inside
 * execute(), so both the schema and the validation use live data.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'

const TMP = mkdtempSync(join(tmpdir(), 'resolve-crewpub-'))

let seq = 0

/** Fake crewai-pse root + wordpress-tools root, freshly created per test. */
function makeEnv(keys: string[], articles: string[] = []): { pseDir: string; wpDir: string } {
  const id = `${Date.now()}-${seq++}`
  const pseDir = join(TMP, `pse-${id}`, 'tasks', 'project-articles')
  mkdirSync(pseDir, { recursive: true })
  const obj: Record<string, unknown> = {}
  for (const k of keys)
    obj[k] = { repo: `x/${k}`, desc: `desc ${k}`, highlights: 'h', source_dir: `src/${k}` }
  writeFileSync(join(pseDir, 'projects.json'), JSON.stringify(obj, null, 2))

  const wpDir = join(TMP, `wp-${id}`)
  const zhDir = join(wpDir, 'articles', 'pse', 'zh')
  mkdirSync(zhDir, { recursive: true })
  for (const a of articles) writeFileSync(join(zhDir, `${a}-zh.md`), '---\ntitle: t\n---\nbody\n')

  return { pseDir: join(TMP, `pse-${id}`), wpDir }
}

function enumOf(root: Context, tool: string): string[] | undefined {
  return (
    root.tools.schemas().find((t) => t.name === tool)?.parameters as {
      properties?: { project?: { enum?: string[] } }
    }
  )?.properties?.project?.enum
}

test('crewai-publish picks up projects and articles added after registration', async () => {
  const { pseDir, wpDir } = makeEnv(['alpha'], ['alpha'])
  process.env.CREWAI_PSE_DIR = pseDir
  process.env.WORDPRESS_TOOLS_DIR = wpDir

  const { toolCrewAiPublish } = await import('../src/plugins/tools/tool-crewai-publish.js')
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(toolCrewAiPublish)

  // Registered with only `alpha`.
  assert.deepEqual(enumOf(root, 'article-validate'), ['alpha'])

  // Later: a new entry in projects.json AND a new article file on disk
  // (the enum is the union of both sources).
  const file = join(pseDir, 'tasks', 'project-articles', 'projects.json')
  const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  obj['beta'] = { repo: 'x/beta', desc: 'd', highlights: 'h', source_dir: 'src/beta' }
  writeFileSync(file, JSON.stringify(obj, null, 2))
  writeFileSync(join(wpDir, 'articles', 'pse', 'zh', 'gamma-zh.md'), 'body\n')

  // No restart: the very next schema read must already show all three.
  assert.deepEqual(enumOf(root, 'article-validate'), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(enumOf(root, 'article-publish'), ['alpha', 'beta', 'gamma'])

  // The no-arg listing (used when the user has not picked one yet) is live too.
  const listed = await root.tools.call('article-validate', {})
  assert.ok(listed.includes('alpha'), 'alpha still present')
  assert.ok(listed.includes('beta'), 'new projects.json entry appears')
  assert.ok(listed.includes('gamma'), 'new article file appears')

  await root.fiber.dispose()
  delete process.env.CREWAI_PSE_DIR
  delete process.env.WORDPRESS_TOOLS_DIR
})

test('crewai-publish rejects a project that is not in either source', async () => {
  const { pseDir, wpDir } = makeEnv(['alpha'])
  process.env.CREWAI_PSE_DIR = pseDir
  process.env.WORDPRESS_TOOLS_DIR = wpDir

  const { toolCrewAiPublish } = await import('../src/plugins/tools/tool-crewai-publish.js')
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(toolCrewAiPublish)

  const result = await root.tools.call('article-validate', { project: 'ghost' })
  assert.match(result, /unknown project "ghost"/)

  await root.fiber.dispose()
  delete process.env.CREWAI_PSE_DIR
  delete process.env.WORDPRESS_TOOLS_DIR
})
