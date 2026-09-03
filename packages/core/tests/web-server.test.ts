/**
 * Web server integration tests: boot the real HTTP bridge on a fixed port and
 * exercise /api/tools, /api/skills and the session CRUD endpoints end-to-end.
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

const PORT = 8899
const BASE = `http://127.0.0.1:${PORT}`

// Create a temp skills dir with a code-review skill for testing
const TMP_SKILLS = mkdtempSync(join(tmpdir(), 'resolve-studio-skills-'))
mkdirSync(join(TMP_SKILLS, 'code-review'), { recursive: true })
writeFileSync(
  join(TMP_SKILLS, 'code-review', 'SKILL.md'),
  '---\nname: code-review\ndescription: 审查代码改动并输出结构化报告\n---\n# Code Review\n步骤...\n',
)

async function buildServer(): Promise<Context> {
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
  await root.plugin(llmMock)
  await root.plugin(toolEcho)
  await root.plugin(gatedCalculator)
  await root.plugin(webServer, { host: '127.0.0.1', port: PORT })
  // server.listen is async; give it a beat to bind.
  await new Promise((r) => setTimeout(r, 300))
  return root
}

test('GET /api/tools and /api/skills', async () => {
  const root = await buildServer()

  const tools = (await (await fetch(`${BASE}/api/tools`)).json()) as {
    tools: { name: string; needsApproval?: boolean }[]
  }
  assert.ok(tools.tools.some((t) => t.name === 'echo'))
  assert.ok(tools.tools.some((t) => t.name === 'calculator' && t.needsApproval))

  const sk = (await (await fetch(`${BASE}/api/skills`)).json()) as {
    skills: { name: string }[]
  }
  assert.ok(sk.skills.some((s) => s.name === 'code-review'))

  await root.fiber.dispose()
})

test('GET /api/tasks lists tasks; POST /api/tasks/match finds the active one', async () => {
  const root = await buildServer()

  const body = (await (await fetch(`${BASE}/api/tasks`)).json()) as {
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
    await fetch(`${BASE}/api/tasks/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '帮我写一篇技术文章并发布到掘金' }),
    })
  ).json()) as { id: string | null; name: string | null }
  assert.equal(hit.id, 'articles')

  const miss = (await (
    await fetch(`${BASE}/api/tasks/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好，介绍一下你自己' }),
    })
  ).json()) as { id: string | null; name: string | null }
  assert.equal(miss.id, null)

  await root.fiber.dispose()
})

test('GET /api/fs lists the read roots, then a directory', async () => {
  const root = await buildServer()

  // Root view: no path → lists the configured read roots as virtual dirs.
  const roots = (await (await fetch(`${BASE}/api/fs`)).json()) as {
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
    await fetch(`${BASE}/api/fs?path=${encodeURIComponent(cwdEntry.path)}`)
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
    await fetch(`${BASE}/api/fs?path=${encodeURIComponent(cwdEntry.path)}`)
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
      await fetch(`${BASE}/api/fs?path=${encodeURIComponent(sub.path)}`)
    ).json()) as {
      parent: string | null
    }
    assert.ok(subListing.parent, 'subdirectory should have a navigable parent')
  }

  // Path traversal outside the sandbox must be rejected (400), not listed.
  const bad = await fetch(`${BASE}/api/fs?path=${encodeURIComponent('/etc')}`)
  assert.equal(bad.status, 400)

  await root.fiber.dispose()
})

test('session CRUD round-trip', async () => {
  const root = await buildServer()
  const id = 't-sess-1'

  const created = await fetch(`${BASE}/api/sessions`, {
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

  const list = (await (await fetch(`${BASE}/api/sessions`)).json()) as {
    sessions: { id: string; messageCount: number }[]
  }
  const found = list.sessions.find((s) => s.id === id)
  assert.ok(found, 'session should appear in list')
  assert.equal(found.messageCount, 1)

  const one = (await (await fetch(`${BASE}/api/sessions/${id}`)).json()) as {
    session: { messages: { content: string }[]; taskMode?: string }
  }
  assert.equal(one.session.messages[0].content, 'hi')
  assert.equal(one.session.taskMode, 'articles', 'taskMode should persist round-trip')

  const del = await fetch(`${BASE}/api/sessions/${id}`, { method: 'DELETE' })
  assert.equal(del.status, 200)

  const after = (await (await fetch(`${BASE}/api/sessions`)).json()) as {
    sessions: { id: string }[]
  }
  assert.ok(!after.sessions.some((s) => s.id === id), 'session should be gone')

  await root.fiber.dispose()
})

test('DELETE /api/sessions clears all stored sessions', async () => {
  const root = await buildServer()
  // Start from a clean slate so other tests' leftovers don't skew the count.
  await fetch(`${BASE}/api/sessions`, { method: 'DELETE' })

  const seed = (id: string) =>
    fetch(`${BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, title: id, messages: [{ role: 'user', content: 'hi' }] }),
    })
  await seed('clear-a')
  await seed('clear-b')

  const before = (await (await fetch(`${BASE}/api/sessions`)).json()) as {
    sessions: { id: string }[]
  }
  assert.equal(before.sessions.length, 2)

  const del = await fetch(`${BASE}/api/sessions`, { method: 'DELETE' })
  assert.equal(del.status, 200)
  const body = (await del.json()) as { removed: number }
  assert.equal(body.removed, 2)

  const after = (await (await fetch(`${BASE}/api/sessions`)).json()) as {
    sessions: { id: string }[]
  }
  assert.equal(after.sessions.length, 0)

  await root.fiber.dispose()
})
