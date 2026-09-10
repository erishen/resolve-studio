/**
 * Web server integration tests: boot the real HTTP bridge on an ephemeral port
 * and exercise /api/tools, /api/skills, /api/fs and the session CRUD endpoints
 * end-to-end.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { AgentService } from '../src/services/agent.js'
import { FastPathService } from '../src/services/fastpath.js'
import { ApprovalService } from '../src/services/approval.js'
import { UsageService } from '../src/services/usage.js'
import { FsRootsService } from '../src/services/fs-roots.js'
import { skills } from '../src/plugins/skills.js'
import { tasks as tasksPlugin } from '../src/plugins/tasks.js'
import { mcpPlugin } from '../src/plugins/mcp.js'
import { llmMock } from '../src/plugins/llm-mock.js'
import { toolEcho } from '../src/plugins/tools/tool-echo.js'
import { webServer } from '../src/plugins/web-server.js'
import { definePlugin } from '../src/plugins/util.js'
import { LlmService } from '../src/services/llm.js'
import type { ChatMessage, ChatOptions, ChatResponse } from '../src/types.js'
import pse from '@resolve-studio/plugin-pse'

// The shared `calculator` tool is not gated, but /api/tools surfaces gating and
// these tests assert it, so register a gated variant with the same name.
const gatedCalculator = definePlugin(
  (ctx: Context): void => {
    ctx.tools.register({
      name: 'calculator',
      description: 'Evaluate a basic arithmetic expression.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      async execute(args) {
        return String(eval(String(args['expression'] ?? '')))
      },
      needsApproval: true,
    })
  },
  'tool-gated-calculator',
  ['tools'],
)

// Port 0 = OS-assigned ephemeral port. A hardcoded port (8899) made the whole
// suite fail with EADDRINUSE whenever anything else on the machine squatted on
// it; each test now binds its own free port and learns it via `onListening`.

// Create a temp skills dir with a code-review skill for testing
const TMP_SKILLS = mkdtempSync(join(tmpdir(), 'resolve-studio-skills-'))
mkdirSync(join(TMP_SKILLS, 'code-review'), { recursive: true })
writeFileSync(
  join(TMP_SKILLS, 'code-review', 'SKILL.md'),
  '---\nname: code-review\ndescription: 审查代码改动并输出结构化报告\n---\n# Code Review\n步骤...\n',
)

/**
 * Boot the bridge on an ephemeral port with its own session dir; resolves once
 * it is actually listening. Both are per-server: test files run in parallel
 * processes (`node --test`), so a shared port or a shared session dir leaks
 * state between them.
 */
async function buildServer(
  // Cordis refuses a second `llm` service in the same context, so a test that
  // needs a different model behaviour injects it here rather than registering
  // it on top of the default mock.
  llm: unknown = llmMock,
): Promise<{ root: Context; base: string }> {
  let bound = 0
  const sessionDir = mkdtempSync(join(tmpdir(), 'resolve-studio-sessions-'))
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(UsageService)
  await root.plugin(FsRootsService)
  await root.plugin(skills, { dir: TMP_SKILLS })
  await root.plugin(tasksPlugin)
  await root.plugin(mcpPlugin)
  await root.plugin(llm as never)
  await root.plugin(toolEcho)
  await root.plugin(gatedCalculator)
  await root.plugin(webServer, {
    host: '127.0.0.1',
    port: 0,
    sessionDir,
    onListening: (info) => {
      bound = info.port
    },
  })
  // server.listen is async: wait for the bind instead of sleeping a fixed beat.
  for (let i = 0; i < 100 && bound === 0; i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!bound) throw new Error('web server did not bind in time')
  return { root, base: `http://127.0.0.1:${bound}` }
}

test('GET /api/tools and /api/skills', async () => {
  const { root, base } = await buildServer()

  const tools = (await (await fetch(`${base}/api/tools`)).json()) as {
    tools: { name: string; needsApproval?: boolean }[]
  }
  assert.ok(tools.tools.some((t) => t.name === 'echo'))
  assert.ok(tools.tools.some((t) => t.name === 'calculator' && t.needsApproval))

  const sk = (await (await fetch(`${base}/api/skills`)).json()) as {
    skills: { name: string }[]
  }
  assert.ok(sk.skills.some((s) => s.name === 'code-review'))

  await root.fiber.dispose()
})

test('GET /api/tasks lists tasks; POST /api/tasks/match finds the active one', async () => {
  const { root, base } = await buildServer()

  const body = (await (await fetch(`${base}/api/tasks`)).json()) as {
    tasks: {
      id: string
      name: string
      description: string
      includeTools: string[]
    }[]
    scopes: {
      id: string
      name: string
      description: string
      includeTools: string[]
    }[]
  }
  assert.ok(body.tasks.some((t) => t.id === 'articles'))
  assert.ok(body.tasks.some((t) => t.id === 'hotnews'))
  const articles = body.tasks.find((t) => t.id === 'articles')
  assert.ok(articles?.includeTools.includes('article-write'))
  // Whitelists must not leak the full feature surface.
  assert.ok(!articles?.includeTools.includes('privacy-audit'))
  // Horizontal capability tiers are exposed separately from business tasks.
  assert.ok(body.scopes.some((s) => s.id === 'core'))
  assert.ok(body.scopes.some((s) => s.id === 'web'))

  const hit = (await (
    await fetch(`${base}/api/tasks/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '帮我写一篇技术文章并发布到掘金' }),
    })
  ).json()) as { id: string | null; name: string | null }
  assert.equal(hit.id, 'articles')

  const miss = (await (
    await fetch(`${base}/api/tasks/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好，介绍一下你自己' }),
    })
  ).json()) as { id: string | null; name: string | null }
  assert.equal(miss.id, null)

  await root.fiber.dispose()
})

test('GET /api/fs lists the read roots, then a directory', async () => {
  const { root, base } = await buildServer()

  // Root view: no path → lists the configured read roots as virtual dirs.
  const roots = (await (await fetch(`${base}/api/fs`)).json()) as {
    dir: string
    parent: string | null
    entries: { name: string; isDir: boolean; path: string }[]
  }
  assert.equal(roots.dir, '')
  assert.equal(roots.parent, null)
  assert.ok(roots.entries.length >= 1, 'at least one read root')
  assert.ok(
    roots.entries.every((e) => e.isDir),
    'root entries are directories',
  )

  // Drill into the cwd root (the first entry) and expect to see its contents.
  const cwdEntry = roots.entries[0]
  const listing = (await (
    await fetch(`${base}/api/fs?path=${encodeURIComponent(cwdEntry.path)}`)
  ).json()) as {
    dir: string
    entries: { name: string }[]
  }
  assert.equal(listing.dir, cwdEntry.path)
  // The project directory should contain at least its package.json.
  assert.ok(
    listing.entries.some((e) => e.name === 'package.json'),
    'cwd should list package.json',
  )

  // A read root must report atRoot:true with a null parent (its filesystem
  // parent is outside the sandbox, so "up" returns to the root list instead).
  const rootView = (await (
    await fetch(`${base}/api/fs?path=${encodeURIComponent(cwdEntry.path)}`)
  ).json()) as {
    atRoot: boolean
    parent: string | null
  }
  assert.equal(rootView.atRoot, true)
  assert.equal(rootView.parent, null)

  // A subdirectory inside the root must expose a non-null parent so the UI's
  // "up" button can navigate back out.
  const sub = listing.entries.find((e) => e.name === 'packages' || e.name === 'apps')
  if (sub) {
    const subListing = (await (
      await fetch(`${base}/api/fs?path=${encodeURIComponent(sub.path)}`)
    ).json()) as {
      parent: string | null
    }
    assert.ok(subListing.parent, 'subdirectory should have a navigable parent')
  }

  // Path traversal outside the sandbox must be rejected (400), not listed.
  const bad = await fetch(`${base}/api/fs?path=${encodeURIComponent('/etc')}`)
  assert.equal(bad.status, 400)

  await root.fiber.dispose()
})

test('session CRUD round-trip', async () => {
  const { root, base } = await buildServer()
  const id = 't-sess-1'

  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      title: 'Test',
      taskMode: 'articles',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  assert.equal(created.status, 200)

  const list = (await (await fetch(`${base}/api/sessions`)).json()) as {
    sessions: { id: string; messageCount: number }[]
  }
  const found = list.sessions.find((s) => s.id === id)
  assert.ok(found, 'session should appear in list')
  assert.equal(found.messageCount, 1)

  const one = (await (await fetch(`${base}/api/sessions/${id}`)).json()) as {
    session: { messages: { content: string }[]; taskMode?: string }
  }
  assert.equal(one.session.messages[0].content, 'hi')
  assert.equal(one.session.taskMode, 'articles', 'taskMode should persist round-trip')

  const del = await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)

  const after = (await (await fetch(`${base}/api/sessions`)).json()) as {
    sessions: { id: string }[]
  }
  assert.ok(!after.sessions.some((s) => s.id === id), 'session should be gone')

  await root.fiber.dispose()
})

test('DELETE /api/sessions clears all stored sessions', async () => {
  const { root, base } = await buildServer()
  // Start from a clean slate so other tests' leftovers don't skew the count.
  await fetch(`${base}/api/sessions`, { method: 'DELETE' })

  const seed = (id: string) =>
    fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title: id, messages: [{ role: 'user', content: 'hi' }] }),
    })
  await seed('clear-a')
  await seed('clear-b')

  const before = (await (await fetch(`${base}/api/sessions`)).json()) as {
    sessions: { id: string }[]
  }
  assert.equal(before.sessions.length, 2)

  const del = await fetch(`${base}/api/sessions`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  const body = (await del.json()) as { removed: number }
  assert.equal(body.removed, 2)

  const after = (await (await fetch(`${base}/api/sessions`)).json()) as {
    sessions: { id: string }[]
  }
  assert.equal(after.sessions.length, 0)

  await root.fiber.dispose()
})

/**
 * LLM that succeeds on the tool round and then gets rate-limited on the
 * follow-up "summarize" turn — the single most common shape of the "the tool
 * ran but nothing came back" report. The tool work is real, so the answer must
 * still show it instead of going blank.
 */
class ToolThenRateLimitedLlm extends LlmService {
  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    if (!messages.some((m) => m.role === 'tool')) {
      return {
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: JSON.stringify({ text: 'ping' }) }],
      }
    }
    throw new Error('429 You’ve reached the API rate limit for free users.')
  }
  async models() {
    return []
  }
}

test('an interrupted run still reports the tool output instead of a blank answer', async () => {
  const { root, base } = await buildServer(ToolThenRateLimitedLlm)
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }),
    })
    const raw = await res.text()
    const events = [...raw.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map((m) => ({
      type: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }))

    const err = events.find((e) => e.type === 'error')
    assert.match(String(err?.data['message']), /429/, 'the provider error is surfaced')

    const done = events.find((e) => e.type === 'done')
    assert.ok(done, 'a `done` is emitted even though the run was interrupted')
    const answer = String(done?.data['answer'] ?? '')
    assert.match(answer, /限流/, 'the answer explains why the run stopped')
    assert.match(answer, /ping/, 'and carries the tool output the user would otherwise never see')
  } finally {
    await root.fiber.dispose()
  }
})

/**
 * Provider returns 429 on the FIRST main-loop LLM call, then succeeds. Without
 * the `nextResponse` retry wrapper the run would die with a blank answer; with
 * it the 429 is retried and the final answer comes back. This is exactly the
 * free-tier quota shape that used to kill tool-using runs.
 */
class FlakyFirstCallLlm extends LlmService {
  private calls = 0
  async chat(_messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    this.calls += 1
    if (this.calls === 1) {
      const e = new Error('429 You have reached the API rate limit for free users.') as Error & {
        status?: number
      }
      e.status = 429
      throw e
    }
    return { content: 'recovered after 429 retry' }
  }
  async models() {
    return []
  }
}

test('a 429 on the main loop is retried and the run recovers', async () => {
  const { root, base } = await buildServer(FlakyFirstCallLlm)
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    const raw = await res.text()
    const events = [...raw.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map((m) => ({
      type: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }))
    const err = events.find((e) => e.type === 'error')
    assert.ok(!err, 'no error event when the 429 is retried successfully')
    const done = events.find((e) => e.type === 'done')
    assert.ok(done, 'a done event is emitted')
    const answer = String(done?.data['answer'] ?? '')
    assert.match(answer, /recovered after 429 retry/, 'the recovered answer is returned')
  } finally {
    await root.fiber.dispose()
  }
})

/**
 * Publish-style tools (juejin/wechat/sf-pw-publish) emit a LONG log whose
 * conclusion prints LAST — "✅ 已发布 → URL", "本批发布 N 篇". An earlier
 * fallback truncated the result to its first 1500 chars, which silently dropped
 * exactly that conclusion and made the answer look truncated. This pins the
 * fixed behaviour: the tail (and therefore the conclusion) is preserved.
 */
const bigEcho = definePlugin(
  (ctx: Context): void => {
    ctx.tools.register({
      name: 'bigecho',
      description: 'Echo a large payload with its conclusion at the end.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async execute(args) {
        const head = 'HEAD_MARK_zzz_被截断的部分'
        const pad = 'x'.repeat(4500)
        return `${head}\n${pad}\n✅ 已发布 → https://segmentfault.com/a/1190000048287087（标签 2 个）\n📝 已记录 sf_id 到 firefly_studio-zh.md\n本批发布 1 篇。剩余未发布 19 篇 → 再跑一次继续下一篇。`
      },
    })
  },
  'tool-big-echo',
  ['tools'],
)

class ToolThenRateLimitedBigLlm extends LlmService {
  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    if (!messages.some((m) => m.role === 'tool')) {
      return {
        toolCalls: [{ id: 'call-1', name: 'bigecho', arguments: JSON.stringify({ text: 'go' }) }],
      }
    }
    throw new Error('429 You’ve reached the API rate limit for free users.')
  }
  async models() {
    return []
  }
}

test('an interrupted run keeps the tail of a large tool output (the conclusion)', async () => {
  const { root, base } = await buildServer(ToolThenRateLimitedBigLlm)
  await root.plugin(bigEcho)
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'publish' }] }),
    })
    const raw = await res.text()
    const events = [...raw.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map((m) => ({
      type: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }))

    const done = events.find((e) => e.type === 'done')
    assert.ok(done, 'a `done` is emitted even though the run was interrupted')
    const answer = String(done?.data['answer'] ?? '')
    // The head (HEAD_MARK_zzz …) lives outside the 4000-char tail window, so it
    // must be elided — proving we no longer dump the whole blob. The conclusion
    // at the very end must still survive.
    assert.ok(!answer.includes('HEAD_MARK_zzz'), 'the head is elided, not dumped verbatim')
    assert.match(answer, /✅ 已发布/, 'the published-URL conclusion is preserved')
    assert.match(answer, /本批发布 1 篇/, 'the per-batch summary is preserved')
    assert.match(answer, /剩余未发布 19 篇/, 'the queue reminder is preserved')
  } finally {
    await root.fiber.dispose()
  }
})

/**
 * Fetch-style tools (hot-news-fetch, kr36 fetch, …) print a long per-source
 * trace where only the last two or three lines carry the actual outcome. The
 * bubble must surface just the conclusion lines — not the ✓/抓取/写入 trace
 * — and the warning must name the model so the user knows what to switch when
 * the provider is rate-limiting.
 */
const hotfetchTool = definePlugin(
  (ctx: Context): void => {
    ctx.tools.register({
      name: 'hotfetch',
      description: 'Simulate a verbose fetch-style tool.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return [
          'hot-news-fetch 完成 → /Users/erishen/.workbuddy/tasks/hot-news/news (全部源)',
          '抓取热点新闻 → /Users/erishen/.workbuddy/tasks/hot-news/news (直连) ✓',
          'weibo: 抓取 30 条 ✓ kr36: 抓取 30 条 ✓ sspai: 抓取 9 条 ✓ qbitai: 抓取 10 条 ✓ infoq: 抓取 20 条 ✓',
          'weibo: 30 条写入 ✓ sspai: 9 条写入 ✓ qbitai: 10 条写入 ✓ infoq: 20 条写入',
          '✅ 完成：新增/更新 99 条，清理旧文件 0 个 → /Users/erishen/.workbuddy/tasks/hot-news/news',
          '📊 总览已生成: /Users/erishen/.workbuddy/tasks/hot-news/hot-news-overview.html',
          '下一步：用 hot-news-topics 列候选话题，再让 hot-news 按平台生成合规文案。',
        ].join('\n')
      },
    })
  },
  'tool-hotfetch',
  ['tools'],
)

class ToolThenRateLimitedHotfetchLlm extends LlmService {
  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    if (!messages.some((m) => m.role === 'tool')) {
      return { toolCalls: [{ id: 'call-1', name: 'hotfetch', arguments: '{}' }] }
    }
    throw new Error('429 You’ve reached the API rate limit for free users.')
  }
  async models() {
    return []
  }
}

test('an interrupted run after a verbose fetch-style tool only surfaces conclusion lines (not the trace)', async () => {
  const { root, base } = await buildServer(ToolThenRateLimitedHotfetchLlm)
  await root.plugin(hotfetchTool)
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'fetch' }],
        model: 'agnes-2.0-flash',
      }),
    })
    const raw = await res.text()
    const events = [...raw.matchAll(/^event: (.+)\ndata: (.+)$/gm)].map((m) => ({
      type: m[1]!,
      data: JSON.parse(m[2]!) as Record<string, unknown>,
    }))

    const done = events.find((e) => e.type === 'done')
    assert.ok(done, 'a `done` is emitted even though the run was interrupted')
    const answer = String(done?.data['answer'] ?? '')

    // The warning must name the model that was rate-limited.
    assert.match(answer, /agnes-2\.0-flash/, 'the warning names the rate-limited model')
    // Conclusion lines must survive.
    assert.match(answer, /✅ 完成：新增\/更新 99 条/, 'the completion summary is preserved')
    assert.match(answer, /📊 总览已生成/, 'the overview-generated line is preserved')
    // The per-source trace and prose hints must NOT pollute the bubble.
    assert.ok(!answer.includes('weibo: 抓取 30 条'), 'the per-source trace is filtered out')
    assert.ok(!answer.includes('下一步：用 hot-news-topics'), 'prose hints are filtered out')
  } finally {
    await root.fiber.dispose()
  }
})

test('each server instance gets its own session dir (no cross-test leakage)', async () => {
  // Session files used to land in the shared `<cwd>/.data/sessions`, so two
  // servers (or two test files running in parallel) saw each other's sessions
  // and the DELETE-all assertions counted foreign rows.
  const a = await buildServer()
  const b = await buildServer()
  try {
    for (const [base, id] of [
      [a.base, 'iso-a'],
      [b.base, 'iso-b'],
    ] as const) {
      const res = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title: id, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(res.status, 200)
    }

    const listA = (await (await fetch(`${a.base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    const listB = (await (await fetch(`${b.base}/api/sessions`)).json()) as {
      sessions: { id: string }[]
    }
    assert.deepEqual(
      listA.sessions.map((s) => s.id),
      ['iso-a'],
      'server A sees only its own session',
    )
    assert.deepEqual(
      listB.sessions.map((s) => s.id),
      ['iso-b'],
      'server B sees only its own session',
    )
  } finally {
    await a.root.fiber.dispose()
    await b.root.fiber.dispose()
  }
})
