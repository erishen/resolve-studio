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
import { absolutizeTaskPath } from '../src/plugins/tools/util-pse.js'

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

/**
 * Regression: the model filled `out` / `news_dir` with the *documented*
 * relative form ("tasks/hot-news/news"). Used verbatim it (a) echoed an
 * unlinkable relative path into the answer bubble and (b) made the Python
 * child mkdir it relative to its cwd, filing the snapshot under
 * <taskDir>/tasks/hot-news/news — a corpus fork nothing else reads.
 */
test('absolutizeTaskPath anchors a relative path at the framework root', () => {
  const FW = '/ws/frameworks/llamaindex-pse'
  const root = () => FW
  assert.equal(
    absolutizeTaskPath('tasks/hot-news/news', root),
    '/ws/frameworks/llamaindex-pse/tasks/hot-news/news',
    'the documented relative form lands on the canonical task dir',
  )
  assert.equal(
    absolutizeTaskPath('./tasks/hot-news/news', root),
    '/ws/frameworks/llamaindex-pse/tasks/hot-news/news',
    './ prefix normalised away',
  )
  assert.equal(
    absolutizeTaskPath('news', root),
    '/ws/frameworks/llamaindex-pse/news',
    'plain name',
  )
  assert.equal(
    absolutizeTaskPath('/already/absolute/news', root),
    '/already/absolute/news',
    'absolute values pass through untouched',
  )
})

/**
 * The framework root comes from an env var that is legitimately unset in
 * tests/CI. An absolute path must therefore never resolve it — otherwise the
 * "missing snapshot dir" guard in hot-news-topics would throw instead of
 * returning its actionable message.
 */
test('absolutizeTaskPath does not touch the framework root for absolute paths', () => {
  let called = false
  const root = () => {
    called = true
    return '/ws/frameworks/llamaindex-pse'
  }
  assert.equal(absolutizeTaskPath('/nonexistent/hot-news/news', root), '/nonexistent/hot-news/news')
  assert.equal(called, false, 'no env read for an absolute path')
})
