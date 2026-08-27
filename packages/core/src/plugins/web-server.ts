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
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from 'cordis'
import { definePlugin } from './util.js'
import { assertWithinRoots } from './fs-guard.js'
import { SessionStore, type SessionRecord } from './session-store.js'
import { WorkspaceManager } from './workspace-manager.js'
import type { ApprovalDecision } from '../services/approval.js'
import type { ChatMessage, ModelInfo, RunEventBus } from '../types.js'

interface WebServerConfig {
  port?: number
  host?: string
  /** Directory where workspace-scan.mjs writes its report (projects.json, index.html, .scan-status.json). */
  workspaceOut?: string
  /** Path to the `uv` binary used by workspace-scan.mjs to run serena. */
  serenaUv?: string
}

const PORT = 8787
const HOST = '127.0.0.1'

// Workspace analysis: the `workspace-scan.mjs` generator writes its report and
// a structured `projects.json` (+ a `.scan-status.json` progress file) into
// this directory. Both paths are configurable via env / plugin config so the
// harness is portable across machines (no hardcoded user paths).
function resolveWorkspaceOut(config: WebServerConfig): string {
  return (
    config.workspaceOut ?? process.env['WORKSPACE_OUT'] ?? join(process.cwd(), 'workspace-analysis')
  )
}
function resolveSerenaUv(config: WebServerConfig): string {
  return config.serenaUv ?? process.env['SERENA_UV'] ?? 'uv'
}

const startWebServer = (ctx: Context, config: WebServerConfig = {}) => {
  const log = ctx.logger('web')
  const port = config.port ?? PORT
  const host = config.host ?? HOST
  const workspaceOut = resolveWorkspaceOut(config)
  const serenaUv = resolveSerenaUv(config)
  const workspaceScript = join(process.cwd(), 'packages/core', 'workspace-scan.mjs')
  const sessions = new SessionStore(join(process.cwd(), '.data', 'sessions'))
  const workspace = new WorkspaceManager(
    {
      outDir: workspaceOut,
      scriptPath: workspaceScript,
      serenaUv,
      cwd: join(process.cwd(), 'packages/core'),
    },
    (level, msg, ...args) => log[level as 'info' | 'warn' | 'error']?.(msg, ...args),
  )

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

    // ---- health check (no auth, lightweight) ----
    if (path === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        memory: process.memoryUsage().heapUsed,
        tools: ctx.tools?.schemas().length ?? 0,
        mcpServers: ctx.mcp ? (await ctx.mcp.list()).length : 0,
      })
      return
    }

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

    // ---- PSE three-role mode status & toggle ----
    if (path === '/api/pse' && req.method === 'GET') {
      const enabled = ctx.pse?.enabled ?? false
      const roles = ctx.pse ? await ctx.pse.list() : []
      sendJson(res, 200, { enabled, roles })
      return
    }
    if (path === '/api/pse' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const parsed = JSON.parse(body || '{}')
        if (typeof parsed.enabled === 'boolean' && ctx.pse) {
          ctx.pse.setEnabled(parsed.enabled)
        }
        sendJson(res, 200, { enabled: ctx.pse?.enabled ?? false })
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
      }
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

    // ---- file content preview (sandboxed to read roots) ----
    if (path === '/api/file' && req.method === 'GET') {
      const filePath = url.searchParams.get('path')
      if (!filePath) {
        sendJson(res, 400, { error: 'missing ?path=' })
        return
      }
      try {
        const abs = resolve(filePath)
        ctx.fsRoots.assertWithin(abs, 'read')
        const fileStat = await stat(abs)
        if (!fileStat.isFile()) {
          sendJson(res, 400, { error: 'not a file' })
          return
        }
        if (fileStat.size > 2 * 1024 * 1024) {
          sendJson(res, 413, {
            error: `file too large (${(fileStat.size / 1024).toFixed(0)}KB > 2MB)`,
          })
          return
        }
        const content = await readFile(abs, { encoding: 'utf8' })
        sendJson(res, 200, { path: abs, size: fileStat.size, content })
      } catch (err) {
        const e = err as Error
        sendJson(res, e.message.includes('outside') || e.message.includes('sandbox') ? 403 : 400, {
          error: e.message,
        })
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
      const server = await ctx.mcp.connect(
        {
          id,
          transport,
          command: typeof cfg['command'] === 'string' ? cfg['command'] : undefined,
          args: Array.isArray(cfg['args']) ? cfg['args'].map(String) : undefined,
          url: typeof cfg['url'] === 'string' ? cfg['url'] : undefined,
          approval: typeof cfg['approval'] === 'boolean' ? cfg['approval'] : undefined,
        },
        { persist: true },
      )
      sendJson(res, server.status === 'connected' ? 200 : 502, { server })
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
      // Pass ?sessionId=<id> to get that conversation's totals instead of the
      // global process-wide tally.
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      const snapshot = ctx.usage ? ctx.usage.snapshot(sessionId) : null
      sendJson(res, 200, { usage: snapshot })
      return
    }

    // ---- workspace analysis (projects under ***REMOVED***) ----
    if (path === '/api/workspace' && req.method === 'GET') {
      const data = await workspace.getProjects()
      sendJson(res, 200, data)
      return
    }
    if (path === '/api/workspace/status' && req.method === 'GET') {
      sendJson(res, 200, await workspace.getStatus())
      return
    }
    if (path === '/api/workspace/rescan' && req.method === 'POST') {
      const force = url.searchParams.get('force') === '1'
      const result = await workspace.rescan(force)
      sendJson(res, result.conflict ? 409 : result.started ? 200 : 500, result)
      return
    }
    if (path === '/api/workspace/stop' && req.method === 'POST') {
      sendJson(res, 200, await workspace.stop())
      return
    }
    if (path.startsWith('/api/workspace/rescan/') && req.method === 'POST') {
      const key = decodeURIComponent(path.slice('/api/workspace/rescan/'.length))
      const result = await workspace.rescanProject(key)
      const status =
        result.error === 'invalid project key'
          ? 400
          : result.conflict
            ? 409
            : result.started
              ? 200
              : 500
      sendJson(res, status, result)
      return
    }
    if (path === '/api/workspace/report' && req.method === 'GET') {
      const buf = await workspace.getReport()
      if (!buf) {
        sendJson(res, 404, { error: 'report not found — run a scan first' })
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(buf)
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
      sendJson(
        res,
        ok ? 200 : 404,
        ok ? { ok: true } : { error: `no pending approval for ${callId}` },
      )
      return
    }

    // ---- session persistence ----
    if (path === '/api/sessions' && req.method === 'GET') {
      const list = await sessions.list()
      sendJson(res, 200, { sessions: list })
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
      const id = typeof rec.id === 'string' ? rec.id : ''
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        sendJson(res, 400, { error: 'session id is required and must be [a-zA-Z0-9_-]' })
        return
      }
      const now = new Date().toISOString()
      const existing = await sessions.get(id)
      const record: SessionRecord = {
        id,
        title:
          typeof rec.title === 'string' && rec.title
            ? rec.title.slice(0, 80)
            : (existing?.title ?? 'Untitled'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages: Array.isArray(rec.messages) ? rec.messages : (existing?.messages ?? []),
      }
      await sessions.set(record)
      sendJson(res, 200, { ok: true, session: { ...record } })
      return
    }
    if (path === '/api/sessions' && req.method === 'DELETE') {
      const removed = await sessions.clear()
      sendJson(res, 200, { ok: true, removed })
      return
    }
    if (path.startsWith('/api/sessions/') && req.method === 'GET') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      const rec = await sessions.get(id)
      if (!rec) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      sendJson(res, 200, { session: rec })
      return
    }
    if (path.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/sessions/'.length))
      const ok = await sessions.remove(id)
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
    let parsed: {
      messages?: ChatMessage[]
      model?: string
      sessionId?: string
      systemPrompt?: string
    }
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
          case 'agent/tool-progress':
            send('tool-progress', { payload })
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
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : undefined,
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
  // close it on SIGINT so the port is freed promptly during dev. The listener
  // is tracked and removed in the disposer so repeated start/stop cycles (e.g.
  // in tests) don't leak listeners and trigger MaxListenersExceededWarning.
  const onSigint = () => server.close()
  process.on('SIGINT', onSigint)

  // Disposer: close the HTTP server when the composition is disposed (used by
  // tests and graceful shutdown paths) so the port is released. Await the
  // close callback so a subsequent server on the same port can't EADDRINUSE.
  return () => {
    process.off('SIGINT', onSigint)
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
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
async function listFs(
  dirParam: string | null,
  roots: string[],
): Promise<{
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

export const webServer = definePlugin(startWebServer, 'web-server', [
  'agent',
  'tools',
  'llm',
  'approval',
  'skills',
  'mcp',
  'usage',
  'fsRoots',
])
