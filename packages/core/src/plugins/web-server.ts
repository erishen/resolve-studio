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
import type { JobEvent, JobsService } from '../services/jobs.js'
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

    // ---- CORS 支持（只允许特定的本地前端 origin，不使用 *） ----
    // 允许的 origin 列表：
    // - resolve-studio 自己的前端 (5173)
    // - firefly-studio Electron 前端 (5180)
    // - Electron 生产模式 (file://)
    const ALLOWED_ORIGINS = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5180',
      'http://127.0.0.1:5180',
      'file://',
    ]
    const requestOrigin = req.headers.origin ?? ''
    const isAllowed = ALLOWED_ORIGINS.some((allowed) => requestOrigin.startsWith(allowed))
    if (isAllowed && requestOrigin) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin)
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')

    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

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
      // Wait for startup MCP connections (bounded inside mcp) so the first paint
      // includes slow-booting servers (Serena/pse-review); otherwise the UI would
      // miss their tools and derived example prompts until a manual reload.
      if (ctx.mcp) await ctx.mcp.whenReady()
      const tools = ctx.tools.schemas()
      sendJson(res, 200, { tools })
      return
    }

    if (path === '/api/skills' && req.method === 'GET') {
      const skills = ctx.skills ? await ctx.skills.list() : []
      sendJson(res, 200, { skills })
      return
    }

    // ---- Task registry (professional tool-set selection) ----
    // Resolved via no-throw `ctx.get('tasks')` (same as the agent loop) so the
    // endpoint still answers gracefully when the optional service isn't loaded.
    const tasksSvc = ctx.get('tasks') as unknown as
      | {
          list(): Promise<
            {
              id: string
              name: string
              description: string
              includeTools: string[]
              systemPrompt?: string
            }[]
          >
          listScopes(): Promise<
            { id: string; name: string; description: string; includeTools: string[] }[]
          >
          match(m: string): Promise<
            | {
                id: string
                name: string
                description: string
                includeTools: string[]
                systemPrompt?: string
              }
            | undefined
          >
        }
      | undefined
    if (path === '/api/tasks' && req.method === 'GET') {
      const tasks = tasksSvc ? await tasksSvc.list() : []
      const scopes = tasksSvc ? await tasksSvc.listScopes() : []
      // Surface only what the UI needs for the mode picker (no keywords).
      sendJson(res, 200, {
        tasks: tasks.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          includeTools: t.includeTools,
          systemPrompt: t.systemPrompt ?? undefined,
        })),
        scopes: scopes.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          includeTools: s.includeTools,
        })),
      })
      return
    }
    if (path === '/api/tasks/match' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const parsed = JSON.parse(body || '{}')
        const message = typeof parsed.message === 'string' ? parsed.message : ''
        const matched = tasksSvc ? await tasksSvc.match(message) : undefined
        sendJson(res, 200, { id: matched?.id ?? null, name: matched?.name ?? null })
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
      }
      return
    }

    // ---- background jobs (detached long-running runs) ----
    // Optional service: without it every endpoint answers 503 so the UI can
    // degrade gracefully instead of crashing the composition.
    const jobsSvc = ctx.get('jobs') as unknown as JobsService | undefined

    if (path === '/api/jobs' && req.method === 'GET') {
      sendJson(res, 200, { jobs: jobsSvc ? await jobsSvc.list() : [] })
      return
    }
    if (path === '/api/jobs' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const parsed = JSON.parse(body || '{}')
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : ''
        if (!prompt) {
          sendJson(res, 400, { error: 'prompt is required' })
          return
        }
        if (!jobsSvc) {
          sendJson(res, 503, { error: 'jobs service not loaded' })
          return
        }
        const job = await jobsSvc.create({
          prompt,
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          taskId: typeof parsed.taskId === 'string' ? parsed.taskId : undefined,
          model: typeof parsed.model === 'string' ? parsed.model : undefined,
          systemPrompt: typeof parsed.systemPrompt === 'string' ? parsed.systemPrompt : undefined,
          includeTools: Array.isArray(parsed.includeTools)
            ? (parsed.includeTools as string[]).filter((t) => typeof t === 'string')
            : undefined,
          excludeTools: Array.isArray(parsed.excludeTools)
            ? (parsed.excludeTools as string[]).filter((t) => typeof t === 'string')
            : undefined,
        })
        sendJson(res, 200, { job })
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' })
      }
      return
    }

    const jobDetail = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/)
    if (jobDetail && req.method === 'GET') {
      const job = jobsSvc ? await jobsSvc.get(jobDetail[1]) : null
      if (!job) {
        sendJson(res, 404, { error: 'job not found' })
        return
      }
      sendJson(res, 200, { job })
      return
    }
    if (jobDetail && req.method === 'DELETE') {
      const ok = jobsSvc ? await jobsSvc.remove(jobDetail[1]) : false
      sendJson(res, ok ? 200 : 404, { ok })
      return
    }

    const jobCancel = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/cancel$/)
    if (jobCancel && req.method === 'POST') {
      const ok = jobsSvc ? await jobsSvc.cancel(jobCancel[1]) : false
      sendJson(res, ok ? 200 : 409, { ok })
      return
    }

    const jobResume = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/resume$/)
    if (jobResume && req.method === 'POST') {
      if (!jobsSvc) {
        sendJson(res, 503, { error: 'jobs service not loaded' })
        return
      }
      const body = await readBody(req)
      let instruction: string | undefined
      try {
        const parsed = JSON.parse(body || '{}')
        if (typeof parsed.instruction === 'string') instruction = parsed.instruction
      } catch {
        /* empty body / invalid JSON → resume without extra instruction */
      }
      const ok = await jobsSvc.resume(jobResume[1], instruction)
      sendJson(res, ok ? 200 : 409, { ok })
      return
    }

    const jobFiles = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/files$/)
    if (jobFiles && req.method === 'GET') {
      if (!jobsSvc) {
        sendJson(res, 503, { error: 'jobs service not loaded' })
        return
      }
      const job = await jobsSvc.get(jobFiles[1])
      if (!job) {
        sendJson(res, 404, { error: 'job not found' })
        return
      }
      // Recursively list the job's workspace so the UI can show intermediate
      // artifacts (reports, generated files) and preview them.
      const files = await listJobFiles(job.workspace)
      sendJson(res, 200, { files })
      return
    }

    const jobStream = path.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/stream$/)
    if (jobStream && req.method === 'GET') {
      if (!jobsSvc) {
        sendJson(res, 503, { error: 'jobs service not loaded' })
        return
      }
      const job = await jobsSvc.get(jobStream[1])
      if (!job) {
        sendJson(res, 404, { error: 'job not found' })
        return
      }
      const terminal =
        job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      const send = (event: string, data: unknown) => {
        if (res.writableEnded) return
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      // Subscribe before reading the stored record so no event emitted between
      // the snapshot read and the live tail is lost (buffered, then flushed).
      let flushed = false
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        try {
          res.end()
        } catch {
          /* already closed */
        }
      }
      const pending: JobEvent[] = []
      const unsub = jobsSvc.subscribe(job.id, (ev) => {
        if (!flushed) {
          pending.push(ev)
          return
        }
        send('job', ev)
        if (ev.type === 'done') end()
      })
      send('snapshot', { status: job.status, events: job.events })
      flushed = true
      for (const ev of pending) {
        send('job', ev)
        if (ev.type === 'done') {
          end()
          break
        }
      }
      if (terminal && !ended) end()
      req.on('close', () => {
        unsub()
        end()
      })
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
      // Wait for startup connections (bounded inside mcp) so the first fetch
      // returns the full server list, not just whichever connected first
      // (e.g. only fs while serena/pse-review are still booting).
      if (ctx.mcp) await ctx.mcp.whenReady()
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

    // ---- workspace analysis (projects under the workspace) ----
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
      const messages = Array.isArray(rec.messages) ? rec.messages : (existing?.messages ?? [])
      // Only bump updatedAt when the conversation content actually changed. A
      // bare re-save of identical history (e.g. just opening the session) must
      // NOT refresh the timestamp — otherwise the session jumps to the top of
      // the list even though nothing new was produced.
      const contentUnchanged =
        !!existing && JSON.stringify(existing.messages) === JSON.stringify(messages)
      const record: SessionRecord = {
        id,
        title:
          typeof rec.title === 'string' && rec.title
            ? rec.title.slice(0, 80)
            : (existing?.title ?? 'Untitled'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: contentUnchanged ? existing!.updatedAt : now,
        taskMode:
          typeof rec.taskMode === 'string' && rec.taskMode
            ? rec.taskMode.slice(0, 80)
            : (existing?.taskMode ?? 'auto'),
        messages,
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

    // Direct single-tool execution (retry buttons/RPA): run one registered tool
    // by name with given args, streaming the same SSE event vocabulary as the
    // chat flow (tool-call / approval-request / tool-progress / tool-result /
    // done). Approval gating is honored exactly like the agent loop.
    if (path === '/api/tool/run' && req.method === 'POST') {
      await handleToolRun(req, res)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  }

  async function handleToolRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let parsed: { name?: unknown; arguments?: Record<string, unknown> }
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    const name = parsed.name
    if (typeof name !== 'string' || !name) {
      sendJson(res, 400, { error: 'expected { name }' })
      return
    }
    const args: Record<string, unknown> =
      parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {}
    if (!ctx.tools.get(name)) {
      sendJson(res, 404, { error: `tool not found: ${name}` })
      return
    }

    const ac = new AbortController()
    req.on('close', () => ac.abort())

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

    // Same event vocab as the chat SSE stream so the web client reuses its
    // existing tool-state handling. Approval request is routed here as well.
    const bus: RunEventBus = {
      emit(event: string, payload?: unknown) {
        if (event === 'agent/tool-call') send('tool-call', { call: payload })
        else if (event === 'agent/tool-progress') send('tool-progress', { payload })
        else if (event === 'agent/tool-result') send('tool-result', { payload })
        else if (event === 'agent/approval-request') send('approval-request', { call: payload })
      },
    }

    const call = { id: `tool-${Math.random().toString(36).slice(2, 10)}`, name, arguments: args }
    send('tool-call', { call })

    try {
      if (ctx.tools.needsApproval(name, args) && ctx.approval) {
        const decision = await ctx.approval.request(call, bus)
        if (decision === 'reject') {
          const result = `User rejected the tool call "${name}".`
          send('tool-result', { payload: { call, result, ok: false, durationMs: 0 } })
          send('done', { answer: result })
          return
        }
      }
      const t0 = performance.now()
      const result = await ctx.tools.call(name, args, {
        onProgress: (chunk: string) => send('tool-progress', { payload: { id: call.id, chunk } }),
      })
      send('tool-result', {
        payload: {
          call,
          result,
          ok: !result.startsWith('error:'),
          durationMs: performance.now() - t0,
        },
      })
      send('done', { answer: result })
    } catch (err) {
      send('error', { message: (err as Error).message })
    } finally {
      if (!res.writableEnded) res.end()
    }
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    let parsed: {
      messages?: ChatMessage[]
      model?: string
      sessionId?: string
      systemPrompt?: string
      /** Forced task mode ('auto' | task id); controls the tool whitelist. */
      taskId?: string
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
          // NOTE: `{ call: … }`, not `{ payload: … }` — the web client types
          // this as `{ type: 'tool-call'; call: ToolCall }` (apps/web/src/
          // types.ts). The `{ payload }`-shaped duplicate branch that used to
          // sit here was both dead (unreachable) and shape-incompatible.
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
        taskId: typeof parsed.taskId === 'string' ? parsed.taskId : undefined,
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
  // close it on SIGINT so the port is freed promptly during dev. A bare
  // `server.close()` would leave the process alive (this listener overrides
  // Node's default SIGINT exit), which is why dev needed a second Ctrl+C — so
  // we exit right away to let the dev shell reap the backend in one press. The
  // listener is tracked and removed in the disposer so repeated start/stop
  // cycles (e.g. in tests) don't leak listeners or trigger
  // MaxListenersExceededWarning.
  const onSigint = () => {
    server.close()
    process.exit(130)
  }
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

export interface JobFile {
  /** Relative path inside the job workspace (e.g. "report.md", "out/data.json"). */
  path: string
  size: number
  /** Last-modified ISO string. */
  mtime: string
}

/** Recursively list a job workspace's artifacts (relative paths + size + mtime). */
async function listJobFiles(workspace: string | undefined): Promise<JobFile[]> {
  if (!workspace) return []
  const out: JobFile[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let info
      try {
        info = await stat(full)
      } catch {
        continue // skip unreadable entries
      }
      if (info.isDirectory()) {
        await walk(full, relPath)
      } else {
        out.push({
          path: relPath,
          size: info.size,
          mtime: info.mtime.toISOString(),
        })
      }
    }
  }
  await walk(workspace, '')
  // Directories first, then by path — stable, preview-friendly order.
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
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

// Local agent harness: bound to localhost, so a generous body cap is fine.
// A saved session can hold a full long-form article plus tool results/reasoning
// and easily top 1 MiB — 16 MiB covers long conversations without risk.
const MAX_BODY_BYTES = 16 * 1024 * 1024

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
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
  'pse',
])
