/**
 * publish-pending — regression for the "掘金无稿" mislabeling that made the
 * agent no-op: `make juejin-draft` only scans articles/juejin/, so a row whose
 * source still lives in articles/pse/zh (or has no juejin copy yet) is NOT
 * actionable by juejin-draft, while a row with a matching juejin copy is.
 *
 * The generator now emits three distinct juejin statuses for not-yet-published
 * rows — draft (有稿未建草稿), seed (无稿但 zh 有源，可 make build-juejin), and
 * missing (pse 稿未归并，需先发布+归档) — and this tool must surface a different
 * next-step for each so the agent stops retrying juejin-draft blindly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'

function makeLifeDash(rows: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), 'resolve-pending-'))
  const dir = join(root, 'src', 'data')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'articlePublish.json'),
    JSON.stringify({ summary: { total: rows.length, jjNotPub: 3 }, queue: [], rows }),
  )
  return root
}

const cell = (s: string) => ({ s })

test('publish-pending distinguishes juejin draft / seed / missing next-steps', async () => {
  const root = makeLifeDash([
    {
      base: 'a',
      title: '已发',
      wp: cell('pub'),
      en: cell('pub'),
      juejin: cell('pub'),
      sf: cell('pub'),
      wechat: cell('pub'),
      missing: [],
    },
    {
      base: 'b',
      title: '有稿未建草稿',
      wp: cell('pub'),
      en: cell('pub'),
      juejin: cell('draft'),
      sf: cell('pub'),
      wechat: cell('pub'),
      missing: ['juejin'],
    },
    {
      base: 'c',
      title: '可建稿',
      wp: cell('pub'),
      en: cell('pub'),
      juejin: cell('seed'),
      sf: cell('pub'),
      wechat: cell('pub'),
      missing: ['juejin'],
    },
    {
      base: 'd',
      title: '需归档',
      wp: cell('missing'),
      en: cell('missing'),
      juejin: cell('missing'),
      sf: cell('missing'),
      wechat: cell('missing'),
      missing: ['wp', 'en', 'juejin', 'segmentfault', 'wechat'],
    },
  ])
  process.env.LIFE_DASH_DIR = root

  const { toolPublishPending } = await import('../src/plugins/tools/tool-publish-pending.js')
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(toolPublishPending)

  const out = await ctx.tools.call('publish-pending', {})

  // draft → straight to建草稿
  assert.match(out, /有稿未建草稿.*make juejin-draft/)
  // seed → build the juejin copy first
  assert.match(out, /可建稿.*make build-juejin/)
  // missing → publish + archive before any juejin step
  assert.match(out, /需归档.*make archive/)
  // a fully-published row is not listed as a juejin to-do
  assert.doesNotMatch(out, /已发.*→/)

  await ctx.fiber.dispose()
  delete process.env.LIFE_DASH_DIR
})

test('tool-wp-publish registers the build-juejin task', async () => {
  process.env.WORDPRESS_TOOLS_DIR = '/tmp/nonexistent-wordpress-tools'
  const { toolWpPublish } = await import('../src/plugins/tools/tool-wp-publish.js')
  const ctx = new Context()
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(toolWpPublish)

  const names = ctx.tools.schemas().map((t) => t.name)
  assert.ok(names.includes('build-juejin'), 'build-juejin must be registered')
  assert.ok(names.includes('juejin-draft'), 'juejin-draft still registered')

  await ctx.fiber.dispose()
  delete process.env.WORDPRESS_TOOLS_DIR
})
