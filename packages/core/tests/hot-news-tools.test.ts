/**
 * Hot-news tool tests: schema wiring + pre-spawn guards only.
 *
 * The hot-news tools shell out to the llamaindex-pse Python task directory
 * (fetch_news.py / run.py --list-topics / publisher `check`), so executing them
 * here would need a synced uv environment. We keep the test to what can be
 * checked cheaply and safely: the tools register with the right names/schemas,
 * and their argument validation rejects unknown sources/platforms without
 * spawning any process.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { toolHotNewsFetch } from '../src/plugins/tools/tool-hot-news-fetch.js'
import { toolHotNewsTopics } from '../src/plugins/tools/tool-hot-news-topics.js'
import { toolHotNewsCheck } from '../src/plugins/tools/tool-hot-news-check.js'

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(toolHotNewsFetch)
  await root.plugin(toolHotNewsTopics)
  await root.plugin(toolHotNewsCheck)
  return root
}

test('hot-news tools register with the expected names', async () => {
  const root = await buildContext()
  const names = root.tools.list().map((t) => t.name)
  assert.deepEqual(names.sort(), ['hot-news-check', 'hot-news-fetch', 'hot-news-topics'])
  await root.fiber.dispose()
})

test('hot-news-check exposes a platform enum', async () => {
  const root = await buildContext()
  const tool = root.tools.list().find((t) => t.name === 'hot-news-check')
  assert.ok(tool)
  const platform = (tool.parameters.properties?.['platform'] as { enum?: unknown[] } | undefined)
    ?.enum
  assert.deepEqual(platform, ['xiaohongshu', 'zhihu', 'toutiao'])
  await root.fiber.dispose()
})

test('hot-news-fetch rejects unknown sources before spawning anything', async () => {
  const root = await buildContext()
  const res = await root.tools.call('hot-news-fetch', JSON.stringify({ sources: 'bogus-source' }))
  assert.match(res, /^error: hot-news-fetch 未知源/)
  await root.fiber.dispose()
})

test('hot-news-check rejects unknown platforms before spawning anything', async () => {
  const root = await buildContext()
  const res = await root.tools.call('hot-news-check', JSON.stringify({ platform: 'myspace' }))
  assert.match(res, /^error: hot-news-check 未知平台/)
  await root.fiber.dispose()
})

test('hot-news-topics fails fast when the news snapshot is missing', async () => {
  const root = await buildContext()
  const missing = '/nonexistent/hot-news/news'
  const res = await root.tools.call('hot-news-topics', JSON.stringify({ news_dir: missing }))
  assert.match(res, /^error: hot-news-topics 未找到新闻快照目录/)
  await root.fiber.dispose()
})
