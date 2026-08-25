/**
 * Web server plugin — the HTTP bridge between the Cordis runtime and the React
 * UI.
 *
 * This is a "frontend" plugin in the DeepSeek-Harness sense: it sits on the
 * same `ctx.agent` / `ctx.tools` / `ctx.llm` services as the CLI REPL, but
 * instead of reading stdin it serves an HTTP API. The React app (Vite, under
 * `web/`) calls it for chat streaming and runtime metadata.
 *
 * Endpoints:
 *   GET  /api/tools                  → { tools: ToolSchema[] }
 *   GET  /api/models                 → { models: ModelInfo[] }
 *   POST /api/chat  { messages, model }
 *        → text/event-stream of agent events (step / tool-call / tool-result /
 *          done / error), driven by `ctx.agent.run`.
 *
 * Uses only Node's built-in `http` — no extra dependency. Each request spins
 * up short-lived listeners on the agent/tool events and tears them down when
 * the run finishes, so concurrent browser sessions don't cross-talk.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { Context } from 'cordis'
import { definePlugin } from './util.js'
import { assertWithinRoots } from './fs-guard.js'
import type { ApprovalDecision } from '../services/approval.js'
import type {
  ChatMessage,
  ModelInfo,
  RunEventBus,
} from '../types.js'

interface WebServerConfig {
  port?: number
  host?: string
}

const PORT = 8787
const HOST = '127.0.0.1'

const startWebServer = (ctx: Context, config: WebServerConfig = {}) => {
  const log = ctx.logger('web')
  const port = config.port ?? PORT
  const host = config.host ?? HOST

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error('request handler failed: %s', (err as Error).message)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    if (path === '/api/tools' && req.method === 'GET') {
      const tools = ctx.tools.schemas()
      sendJson(res, 200, { tools })
      return
    }

    if (path === '/api/skills' && req.method === 'GET') {
      const skills = ctx.skills ? await ctx.skills.list() : []
      sendJson(res, 200, { skills })
      return
    }

    // ---- filesystem browser (sandboxed to the read roots) ----
    if (path === '/api/fs' && req.method === 'GET') {
      try {
        const dirParam = url.searchParams.get('path')
        const listing = await listFs(dirParam, ctx.fsRoots.read)
        sendJson(res, 200, listing)
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message })
      }
      return
    }

    // ---- MCP server management ----
    if (path === '/api/mcp' && req.method === 'GET') {
      const servers = ctx.mcp ? await ctx.mcp.list() : []
      sendJson(res, 200, { servers })
      return
    }
    if (path === '/api/mcp' && req.method === 'POST') {
      const body = await readBody(req)
      let cfg: Record<string, unknown>
      try {
        cfg = JSON.parse(body || '{}')
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const id = typeof cfg['id'] === 'string' ? cfg['id'] : ''
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        sendJson(res, 400, { error: 'id is required and must be [a-zA-Z0-9_-]' })
        return
      }
      const transport = cfg['transport'] === 'http' ? 'http' : 'stdio'
      const server = await ctx.mcp.connect({
        id,
        transport,
        command: typeof cfg['command'] === 'string' ? cfg['command'] : undefined,
        args: Array.isArray(cfg['args']) ? cfg['args'].map(String) : undefined,
        url: typeof cfg['url'] === 'string' ? cfg['url'] : undefined,
        approval: typeof cfg['approval'] === 'boolean' ? cfg['approval'] : undefined,
      }, { persist: true })
      sendJson(res, server.status === 'connected' ? 200 : 200, { server })
      return
    }
    if (path.startsWith('/api/mcp/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/mcp/'.length))
      const ok = await ctx.mcp.disconnect(id)
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'server not found' })
      return
    }

    if (path === '/api/models' && req.method === 'GET') {
      // The model catalog may come from a remote `/v1/models` call that can
      // fail (offline, unsupported endpoint, auth). Never let that 500 the UI:
      // fall back to an empty list and let defaultModel (if known) drive the
      // pre-selection.
      let models: ModelInfo[] = []
      try {
        models = await ctx.llm.models()
      } catch (err) {
        log.warn('ctx.llm.models() failed: %s', (err as Error).message)
      }
      // Surface the model the backend actually defaults to (config.model or
      // OPENAI_MODEL), so the UI can pre-select it instead of the first entry.
      const defaultModel =
        'defaultModel' in ctx.llm ? (ctx.llm as { defaultModel: string }).defaultModel : undefined
      sendJson(res, 200, { models, defaultModel })
      return
    }

    if (path === '/api/usage' && req.method === 'GET') {
      // `usage` is declared in this plugin's inject list (see `webServer` below),
      // so `ctx.usage` resolves here without Cordis' "without inject" guard.
      const snapshot = ctx.usage ? ctx.usage.snapshot() : null
      sendJson(res, 200, { usage: snapshot })
      return
    }

    // ---- screenshot image serving ----
    if (path.startsWith('/api/screenshots/') && req.method === 'GET') {
      const file = decodeURIComponent(path.slice('/api/screenshots/'.length))
      // Guard against path traversal: only a bare filename is allowed.
      if (!/^[A-Za-z0-9_.-]+\.png$/i.test(file)) {
        sendJson(res, 400, { error: 'invalid screenshot filename' })
        return
      }
      const full = join(process.cwd(), '.data', 'screenshots', file)
      try {
        const s = await stat(full)
        if (!s.isFile()) throw new Error('not a file')
        const buf = await readFile(full)
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
        })
        res.end(buf)
      } catch {
        sendJson(res, 404, { error: 'screenshot not found' })
      }
      return
    }

    if (path === '/api/approval' && req.method === 'POST') {
      const body = await readBody(req)
      let callId: unknown
      let decision: unknown
      try {
        ;({ callId, decision } = JSON.parse(body || '{}'))
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      if (typeof callId !== 'string' || (decision !== 'approve' && decision !== 'reject')) {
        sendJson(res, 400, { error: 'expected { callId, decision: "approve" | "reject" }' })
        return
      }
      const ok = ctx.approval.resolve(callId, decision as ApprovalDecision)
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: `no pending approval for ${callId}` })
      return
    }

    // ---- session persistence ----
    if (path === '/api/sessions' && req.method === 'GET') {
      const sessions = await listSessions()
      sendJson(res, 200, { sessions })
      return
    }
    if (path === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req)
      let rec: Partial<SessionRecord>
      try {
        rec = JSON.parse(body || '{}')
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
        return
      }
      const id = sanitizeId(typeof rec.id === 'string' ? rec.id : '')
      if (!id) {
        sendJson(res, 400, { error: 'session id is required and must be [a-zA-Z0-9_-]' })
        return
      }
      const now = new Date().toISOString()
      const existing = await readSession(id)
      const record: SessionRecord = {
        id,
        title: typeof rec.title === 'string' && rec.title ? rec.title.slice(0, 80) : existing?.title ?? 'Untitled',
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages: Array.isArray(rec.messages) ? rec.messages : existing?.messages ?? [],
      }
      await writeSession(record)
      sendJson(res, 200, { ok: true, session: { ...record } })
      return
    }
    if (path === '/api/sessions' && req.method === 'DELETE') {
      const removed = await clearAllSessions()
      sendJson(res, 200, { ok: true, removed })
      return
    }
    if (path.startsWith('/api/sessions/') && req.method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      const rec = await readSession(id)
      if (!rec) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      sendJson(res, 200, { session: rec })
      return
    }
    if (path.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      const ok = await deleteSession(id)
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'session not found' })
      return
    }

    if (path === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let parsed: { messages?: ChatMessage[]; model?: string }
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const messages = parsed.messages
    if (!Array.isArray(messages) || messages.length === 0) {
      sendJson(res, 400, { error: 'messages must be a non-empty array' })
      return
    }

    // Per-request abort controller. When the client disconnects (e.g. the user
    // hits "Stop"), `req` closes and we abort the in-flight model call so we
    // stop burning tokens instead of running to completion server-side.
    const ac = new AbortController()
    req.on('close', () => ac.abort())

    // SSE handshake.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 2000\n\n')

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // Per-request event bus: route this run's `agent/*` / `llm/*` progress
    // straight to this SSE stream. Because the bus is per-request (not the
    // shared global `ctx.events`), two concurrent /api/chat requests — e.g.
    // two browser tabs — each receive only their own events and never
    // cross-talk. `agent/done` is sent explicitly below once `run()` resolves,
    // so we intentionally skip mapping it here to avoid a duplicate `done`.
    const bus: RunEventBus = {
      emit(event: string, payload?: unknown) {
        switch (event) {
          case 'agent/tool-call':
            send('tool-call', { call: payload })
            return
          case 'agent/tool-result':
            send('tool-result', { payload })
            return
          case 'agent/step':
            send('step', { step: payload })
            return
          case 'agent/approval-request':
            send('approval-request', { call: payload })
            return
          case 'agent/delta':
            send('delta', { text: payload })
            return
          case 'agent/reasoning':
            send('reasoning', { text: payload })
            return
          case 'llm/usage':
            send('usage', { record: payload })
            return
        }
      },
    }

    try {
      const answer = await ctx.agent.run({
        messages,
        model: parsed.model,
        signal: ac.signal,
        runId: `run-${Math.random().toString(36).slice(2, 10)}`,
        bus,
      })
      send('done', { answer })
    } catch (err) {
      send('error', { message: (err as Error).message })
    } finally {
      if (!res.writableEnded) res.end()
    }
  }

  server.listen(port, host, () => {
    log.info('web UI bridge listening on http://%s:%d', host, port)
  })

  // Cordis disposes the root context on process exit via its own fiber; the
  // HTTP server is closed by Node when the process tears down. We additionally
  // close it on SIGINT so the port is freed promptly during dev.
  process.on('SIGINT', () => server.close())

  // Disposer: close the HTTP server when the composition is disposed (used by
  // tests and graceful shutdown paths) so the port is released. Await the
  // close callback so a subsequent server on the same port can't EADDRINUSE.
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
}

interface FsEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

/**
 * List a directory (or, when `dirParam` is empty, the configured read roots)
 * for the frontend file picker. Every path is validated against `roots`
 * so the picker can never surface or navigate outside the sandbox.
 */
async function listFs(dirParam: string | null, roots: string[]): Promise<{
  dir: string
  parent: string | null
  atRoot: boolean
  entries: FsEntry[]
}> {
  // Root view: expose the configured read roots as virtual directories.
  if (!dirParam) {
    return {
      dir: '',
      parent: null,
      atRoot: false,
      entries: roots.map((r) => ({
        name: basename(r) || r,
        path: r,
        isDir: true,
        size: 0,
      })),
    }
  }

  const abs = resolve(dirParam)
  assertWithinRoots(abs, roots)
  // True when `abs` is exactly one of the configured read roots — its filesystem
  // parent lies outside the sandbox, so "up" must return to the root view.
  const atRoot = roots.some((r) => resolve(r) === abs)
  const items = await readdir(abs)
  const entries: FsEntry[] = []
  for (const name of items) {
    const full = join(abs, name)
    let info
    try {
      info = await stat(full)
    } catch {
      continue // skip unreadable entries
    }
    entries.push({
      name,
      path: full,
      isDir: info.isDirectory(),
      size: info.size,
    })
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  // Compute a navigable parent only if it stays inside the sandbox.
  let parent: string | null = null
  const candidate = dirname(abs)
  if (candidate !== abs) {
    try {
      assertWithinRoots(candidate, roots)
      parent = candidate
    } catch {
      parent = null
    }
  }

  return { dir: abs, parent, atRoot, entries }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Session persistence — plain JSON files under `<cwd>/.data/sessions/`.
// A session is the web UI's conversation history; the frontend auto-saves it
// (debounced) via POST /api/sessions.
// ---------------------------------------------------------------------------

interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

interface SessionRecord extends Omit<SessionMeta, 'messageCount'> {
  messages: {
    role: string
    content: string
    toolCalls?: { id?: string; name: string; arguments: unknown; result?: string; ok?: boolean; gated?: boolean; decision?: string }[]
  }[]
}

const SESSIONS_DIR = join(process.cwd(), '.data', 'sessions')

function sanitizeId(id: string): string {
  // Guard against path traversal: ids are client-generated but must not
  // escape the sessions directory.
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true })
}

async function listSessions(): Promise<SessionMeta[]> {
  await ensureSessionsDir()
  let files: string[]
  try {
    files = await readdir(SESSIONS_DIR)
  } catch {
    return []
  }
  const metas: SessionMeta[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await readFile(join(SESSIONS_DIR, f), 'utf8')
      const rec = JSON.parse(raw) as SessionRecord
      metas.push({
        id: rec.id,
        title: rec.title,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        messageCount: rec.messages?.length ?? 0,
      })
    } catch {
      // skip corrupt files
    }
  }
  return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

async function readSession(id: string): Promise<SessionRecord | null> {
  const safe = sanitizeId(id)
  if (!safe) return null
  try {
    const raw = await readFile(join(SESSIONS_DIR, `${safe}.json`), 'utf8')
    return JSON.parse(raw) as SessionRecord
  } catch {
    return null
  }
}

async function writeSession(rec: SessionRecord): Promise<void> {
  await ensureSessionsDir()
  const safe = sanitizeId(rec.id)
  if (!safe) throw new Error('invalid session id')
  await writeFile(join(SESSIONS_DIR, `${safe}.json`), JSON.stringify(rec, null, 2))
}

async function deleteSession(id: string): Promise<boolean> {
  const safe = sanitizeId(id)
  if (!safe) return false
  try {
    await rm(join(SESSIONS_DIR, `${safe}.json`))
    return true
  } catch {
    return false
  }
}

/**
 * Delete every stored session file (all `*.json` under SESSIONS_DIR). Used by
 * the "clear all sessions" action in the web sidebar. Only `.json` entries are
 * touched, so a stray non-session file can't be removed.
 */
async function clearAllSessions(): Promise<number> {
  await ensureSessionsDir()
  let files: string[]
  try {
    files = await readdir(SESSIONS_DIR)
  } catch {
    return 0
  }
  let removed = 0
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      await rm(join(SESSIONS_DIR, f))
      removed += 1
    } catch {
      // ignore individual failures (e.g. already gone)
    }
  }
  return removed
}

export const webServer = definePlugin(startWebServer, 'web-server', ['agent', 'tools', 'llm', 'approval', 'skills', 'mcp', 'usage', 'fsRoots'])
