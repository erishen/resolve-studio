/**
 * Multi-session concurrency — the web bridge must support two (or more)
 * simultaneous chats without their event streams cross-talking.
 *
 * Before this test existed, every `/api/chat` request attached listeners to
 * the *global* `ctx.events` bus, so two concurrent runs leaked each other's
 * `agent/delta` / `agent/step` / `agent/tool-call` events into both SSE
 * streams. The fix scopes each run to a per-request `RunEventBus`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { AgentService } from '../src/services/agent.js'
import { FastPathService } from '../src/services/fastpath.js'
import { ApprovalService } from '../src/services/approval.js'
import { UsageService } from '../src/services/usage.js'
import { FsRootsService } from '../src/services/fs-roots.js'
import { skills } from '../src/plugins/skills.js'
import { mcpPlugin } from '../src/plugins/mcp.js'
import { llmMock } from '../src/plugins/llm-mock.js'
import { toolEcho } from '../src/plugins/tool-echo.js'
import { webServer } from '../src/plugins/web-server.js'

/** A tiny in-memory event sink standing in for a per-run SSE bus. */
function makeBus() {
  const events: { event: string; payload: unknown }[] = []
  return {
    events,
    emit: (event: string, payload?: unknown) => {
      events.push({ event, payload })
    },
  }
}

async function buildRoot() {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(UsageService)
  await root.plugin(FsRootsService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(llmMock)
  await root.plugin(toolEcho)
  return root
}

test('concurrent runs are isolated by their per-run bus (no global leak)', async () => {
  const root = await buildRoot()

  const busA = makeBus()
  const busB = makeBus()

  // A global listener must NOT see any `agent/delta` from the scoped runs.
  let globalDeltas = 0
  root.on('agent/delta', () => {
    globalDeltas++
  })

  const [answerA, answerB] = await Promise.all([
    root.agent.run({ messages: [{ role: 'user', content: 'echo ALPHA' }], bus: busA }),
    root.agent.run({ messages: [{ role: 'user', content: 'echo BRAVO' }], bus: busB }),
  ])

  const deltasA = busA.events
    .filter((e) => e.event === 'agent/delta')
    .map((e) => String(e.payload))
    .join('')
  const deltasB = busB.events
    .filter((e) => e.event === 'agent/delta')
    .map((e) => String(e.payload))
    .join('')

  assert.ok(deltasA.includes('ALPHA'), 'bus A should carry ALPHA')
  assert.ok(!deltasA.includes('BRAVO'), 'bus A must NOT carry BRAVO')
  assert.ok(deltasB.includes('BRAVO'), 'bus B should carry BRAVO')
  assert.ok(!deltasB.includes('ALPHA'), 'bus B must NOT carry ALPHA')

  // No `agent/*` progress leaked onto the shared global bus for scoped runs.
  assert.equal(globalDeltas, 0, 'scoped concurrent runs must not emit agent/delta globally')
  assert.match(answerA, /ALPHA/)
  assert.match(answerB, /BRAVO/)

  await root.fiber.dispose()
})

// ---- end-to-end: two concurrent HTTP /api/chat requests ----

const PORT = 8901
const BASE = `http://127.0.0.1:${PORT}`

async function buildServer(): Promise<Context> {
  const root = await buildRoot()
  await root.plugin(mcpPlugin)
  await root.plugin(webServer, { host: '127.0.0.1', port: PORT })
  await new Promise((r) => setTimeout(r, 300))
  return root
}

interface SseEvent {
  type: string
  data: unknown
}

async function streamChat(body: unknown): Promise<SseEvent[]> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events: SseEvent[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let sep: number
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)
      let type = ''
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (dataLines.length) {
        try {
          events.push({ type, data: JSON.parse(dataLines.join('\n')) })
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
  return events
}

test('two concurrent /api/chat requests stream isolated SSE events', async () => {
  const root = await buildServer()

  const [evA, evB] = await Promise.all([
    streamChat({ messages: [{ role: 'user', content: 'echo ALPHA' }] }),
    streamChat({ messages: [{ role: 'user', content: 'echo BRAVO' }] }),
  ])

  const deltasA = evA.filter((e) => e.type === 'delta').map((e) => (e.data as { text: string }).text).join('')
  const deltasB = evB.filter((e) => e.type === 'delta').map((e) => (e.data as { text: string }).text).join('')

  assert.ok(deltasA.includes('ALPHA'), 'stream A should carry ALPHA')
  assert.ok(!deltasA.includes('BRAVO'), 'stream A must NOT carry BRAVO')
  assert.ok(deltasB.includes('BRAVO'), 'stream B should carry BRAVO')
  assert.ok(!deltasB.includes('ALPHA'), 'stream B must NOT carry ALPHA')

  await root.fiber.dispose()
})
