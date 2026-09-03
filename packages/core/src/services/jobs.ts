/**
 * Jobs service — detached, long-running agent runs with persistence.
 *
 * A *job* is a `ctx.agent.run()` that is NOT tied to an HTTP request (closing
 * the browser tab won't kill it). The run's events are streamed into an
 * append-only event log, persisted to `.data/jobs/<id>.json`, and broadcast to
 * live subscribers so the UI can re-attach to a running job (SSE) or render a
 * finished one from its stored transcript.
 *
 * Each job runs in its OWN workspace (`<dir>/<id>/workspace/`): write-file /
 * read-file / shell anchor relative paths and the shell cwd there, and it is
 * added as an extra OS-sandbox writable root. Jobs also run with a tool
 * whitelist (optional `includeTools`) and with `skipApproval` (no human gate).
 * The full message transcript is persisted so a job can be RESUMED: `resume()`
 * re-runs from the last transcript against the same workspace, letting an
 * interrupted run pick up where it left off.
 *
 * State machine: queued → running → succeeded | failed | cancelled. Runs left
 * `running` across a restart are marked failed on the next read (the in-memory
 * run state is gone); use `resume()` to continue them.
 */

import { mkdir } from 'node:fs/promises'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from 'cordis'
import { Service } from 'cordis'
import { definePlugin } from '../plugins/util.js'
import type { AgentStep, ChatMessage, RunEventBus, ToolCall } from '../types.js'

declare module 'cordis' {
  interface Context {
    jobs: JobsService
  }
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobUsage {
  prompt: number
  completion: number
  cost: number
}

/** One append-only log entry of a job's run. `seq` is the monotonic index. */
export type JobEvent =
  | { seq: number; type: 'step'; step: AgentStep }
  | { seq: number; type: 'tool-call'; call: ToolCall }
  | {
      seq: number
      type: 'tool-result'
      call: ToolCall
      result: string
      ok: boolean
      durationMs: number
    }
  | { seq: number; type: 'tool-progress'; id: string; chunk: string }
  | { seq: number; type: 'approval-request'; call: ToolCall }
  | { seq: number; type: 'delta'; text: string }
  | { seq: number; type: 'reasoning'; text: string }
  | {
      seq: number
      type: 'usage'
      record: { model: string; promptTokens: number; completionTokens: number; cost: number }
    }
  | { seq: number; type: 'done'; answer: string }

export interface JobRecord {
  id: string
  /** Short human label (defaults to the prompt head). */
  name: string
  /** The original user prompt that started the run. */
  prompt: string
  /** Pinned task mode ('auto' when omitted). */
  taskId?: string
  model?: string
  /** Tool whitelist prefixes for this run (empty = all tools). */
  includeTools?: string[]
  /** Tool blacklist prefixes for this run. */
  excludeTools?: string[]
  /** Per-job working directory; tools anchor relative paths & shell cwd here. */
  workspace?: string
  status: JobStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
  /** Final answer (also captured from the `done` event). */
  answer?: string
  usage?: JobUsage
  /** Message transcript for resume (user + assistant + tool turns). */
  messages?: ChatMessage[]
  events: JobEvent[]
}

export interface JobMeta {
  id: string
  name: string
  taskId?: string
  status: JobStatus
  createdAt: string
  updatedAt: string
  eventCount: number
}

export interface JobsConfig {
  /** Directory for the SQLite DB and per-job workspaces.
   *  Defaults to `<cwd>/.data/jobs`. */
  dir?: string
  /** SQLite database filename inside `dir`. Defaults to `jobs.db`. */
  db?: string
  /** Maximum number of jobs running at once; excess jobs queue (status stays
   *  `queued`) until a slot frees up. Defaults to 3. */
  maxConcurrent?: number
}

export interface CreateJobInput {
  prompt: string
  name?: string
  taskId?: string
  model?: string
  systemPrompt?: string
  /** Tool whitelist prefixes (e.g. ['article-write','read-file']); empty = all. */
  includeTools?: string[]
  /** Tool blacklist prefixes. */
  excludeTools?: string[]
}

/** A job event with the auto-assigned `seq` still to fill in (for recording). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type NewJobEvent = DistributiveOmit<JobEvent, 'seq'>

/** Strip anything that isn't a safe filename char (anti path-traversal). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

export class JobsService extends Service {
  private readonly dir: string
  /** SQLite handle; the source of truth for every job record. */
  private readonly db: DatabaseSync
  /** Live in-memory runs: job id → abort controller + the live record object
   *  (so cancel mutates the same `rec` the run loop holds, not a stale copy). */
  private readonly running = new Map<string, { ac: AbortController; rec: JobRecord }>()
  /** Live SSE subscribers: job id → set of callbacks (for re-attach). */
  private readonly live = new Map<string, Set<(ev: JobEvent) => void>>()
  /** Debounced per-job persist timers. */
  private readonly pendingSave = new Map<string, NodeJS.Timeout>()
  /** Max simultaneous active runs (see JobsConfig.maxConcurrent). */
  private readonly maxConcurrent: number
  /** Number of runs currently holding a concurrency slot. */
  private active = 0
  /** FIFO of waiters that release a slot. Holds `job id → release()`. */
  private readonly queue: Array<{ id: string; release: () => void }> = []
  /** Jobs cancelled while still queued for a slot (so they bail before start). */
  private readonly cancelledQueued = new Set<string>()

  constructor(ctx: Context, config: JobsConfig = {}) {
    super(ctx, 'jobs')
    this.dir = config.dir ?? join(process.cwd(), '.data', 'jobs')
    this.dbFilename = config.db ?? 'jobs.db'
    this.maxConcurrent = config.maxConcurrent ?? 3
    // The directory must exist before the SQLite file is opened (and it is
    // where each job's workspace subdir lives).
    mkdirSync(this.dir, { recursive: true })
    this.db = new DatabaseSync(join(this.dir, this.dbFilename))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id     TEXT PRIMARY KEY,
        record TEXT NOT NULL
      )
    `)
    this.prepareStatements()
    this.migrateLegacyJson()
  }

  /** Filename of the SQLite DB inside `dir` (see JobsConfig.db). */
  private readonly dbFilename: string

  /**
   * Acquire a concurrency slot, awaiting if the limit is reached. While waiting,
   * the job stays `queued`; its turn order is FIFO. The released slot always
   * hands the spare capacity to the next queued waiter.
   */
  private async acquire(id: string): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      return () => {
        this.active--
        this.dispatchNext()
      }
    }
    return new Promise<() => void>((resolve) => {
      const entry = {
        id,
        release: () => {
          this.active++
          resolve(() => {
            this.active--
            this.dispatchNext()
          })
        },
      }
      this.queue.push(entry)
    })
  }

  /** Grant the next queued job its slot, if any are waiting. */
  private dispatchNext(): void {
    const next = this.queue.shift()
    if (next) next.release()
  }

  // ---- persistence (SQLite-backed, one row per job) ----

  private stmtWrite!: ReturnType<DatabaseSync['prepare']>
  private stmtRead!: ReturnType<DatabaseSync['prepare']>
  private stmtList!: ReturnType<DatabaseSync['prepare']>
  private stmtDelete!: ReturnType<DatabaseSync['prepare']>

  private prepareStatements(): void {
    this.stmtWrite = this.db.prepare(
      'INSERT INTO jobs (id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record',
    )
    this.stmtRead = this.db.prepare('SELECT record FROM jobs WHERE id = ?')
    this.stmtList = this.db.prepare('SELECT record FROM jobs ORDER BY rowid')
    this.stmtDelete = this.db.prepare('DELETE FROM jobs WHERE id = ?')
  }

  /** One-time import of any legacy `<dir>/<id>.json` records into SQLite. */
  private migrateLegacyJson(): void {
    let files: string[]
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      return
    }
    for (const f of files) {
      const id = f.replace(/\.json$/, '')
      const existing = this.stmtRead.get(sanitizeId(id)) as { record?: string } | undefined
      if (existing) continue
      try {
        const raw = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as JobRecord
        this.stmtWrite.run(raw.id, JSON.stringify(raw))
      } catch {
        this.ctx.logger('jobs').warn('skipping unreadable legacy job file %s', f)
      }
    }
  }

  private persist(rec: JobRecord): Promise<void> {
    this.stmtWrite.run(rec.id, JSON.stringify(rec))
    return Promise.resolve()
  }

  private load(id: string): Promise<JobRecord | null> {
    const row = this.stmtRead.get(id) as { record?: string } | undefined
    if (!row?.record) return Promise.resolve(null)
    try {
      return Promise.resolve(JSON.parse(row.record) as JobRecord)
    } catch {
      return Promise.resolve(null)
    }
  }

  /** Debounced persist — delta events stream in fast; don't hit disk each one. */
  private touch(rec: JobRecord): void {
    rec.updatedAt = new Date().toISOString()
    const existing = this.pendingSave.get(rec.id)
    if (existing) clearTimeout(existing)
    this.pendingSave.set(
      rec.id,
      setTimeout(() => {
        this.pendingSave.delete(rec.id)
        void this.persist(rec).catch((e) =>
          this.ctx.logger('jobs').warn('persist failed: %s', e.message),
        )
      }, 300),
    )
  }

  private flush(rec: JobRecord): void {
    const existing = this.pendingSave.get(rec.id)
    if (existing) {
      clearTimeout(existing)
      this.pendingSave.delete(rec.id)
    }
    void this.persist(rec).catch((e) => this.ctx.logger('jobs').warn('flush failed: %s', e.message))
  }

  /** Mark runs that were `running` when this process booted as interrupted. */
  private async reviveIfNeeded(rec: JobRecord): Promise<JobRecord> {
    if (rec.status === 'running' && !this.running.has(rec.id)) {
      rec.status = 'failed'
      rec.error = 'interrupted by restart'
      rec.finishedAt = new Date().toISOString()
      rec.updatedAt = rec.finishedAt
      await this.persist(rec)
    }
    return rec
  }

  // ---- public API ----

  async list(): Promise<JobMeta[]> {
    const rows = this.stmtList.all() as Array<{ record: string }>
    const metas: JobMeta[] = []
    for (const row of rows) {
      let rec: JobRecord
      try {
        rec = JSON.parse(row.record) as JobRecord
      } catch {
        continue
      }
      await this.reviveIfNeeded(rec)
      metas.push({
        id: rec.id,
        name: rec.name,
        taskId: rec.taskId,
        status: rec.status,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        eventCount: rec.events.length,
      })
    }
    return metas.sort((a, b) =>
      a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1,
    )
  }

  async get(id: string): Promise<JobRecord | null> {
    const rec = await this.load(id)
    if (!rec) return null
    await this.reviveIfNeeded(rec)
    return rec
  }

  async create(input: CreateJobInput): Promise<JobRecord> {
    const id = `job-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const name =
      (input.name ?? input.prompt).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled job'
    const now = new Date().toISOString()
    // Each job gets its own workspace directory; tools anchor relative paths &
    // the shell cwd here, and it is added as a sandbox writable root.
    const workspace = join(this.dir, id, 'workspace')
    await mkdir(workspace, { recursive: true })
    const rec: JobRecord = {
      id,
      name,
      prompt: input.prompt,
      taskId: input.taskId && input.taskId !== 'auto' ? input.taskId : undefined,
      model: input.model,
      includeTools: input.includeTools?.length ? input.includeTools : undefined,
      excludeTools: input.excludeTools?.length ? input.excludeTools : undefined,
      workspace,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'user', content: input.prompt }],
      events: [],
    }
    await this.persist(rec)
    // Run detached: don't block the caller (the HTTP request returns the job id
    // immediately). Errors are contained inside runJob → job status, never throw.
    void this.runJob(rec, input)
    return rec
  }

  /**
   * Resume an interrupted / failed job. Re-runs the agent from the persisted
   * message transcript against the SAME workspace (intermediate artifacts are
   * still there), optionally with an extra instruction. Returns false when the
   * job doesn't exist or is still running.
   */
  async resume(id: string, instruction?: string): Promise<boolean> {
    if (this.running.has(id)) return false
    const rec = await this.load(id)
    if (!rec) return false
    // Re-run from the saved transcript (+ optional continuation instruction).
    const seed: ChatMessage[] = rec.messages?.length
      ? rec.messages
      : [{ role: 'user', content: rec.prompt }]
    const messages: ChatMessage[] = [...seed]
    if (instruction?.trim()) messages.push({ role: 'user', content: instruction.trim() })
    const now = new Date().toISOString()
    rec.messages = messages
    rec.events = []
    rec.answer = undefined
    rec.error = undefined
    rec.usage = undefined
    rec.status = 'queued'
    rec.startedAt = undefined
    rec.finishedAt = undefined
    rec.updatedAt = now
    await this.persist(rec)
    void this.runJob(rec, {
      prompt: rec.prompt,
      taskId: rec.taskId,
      model: rec.model,
      includeTools: rec.includeTools,
      excludeTools: rec.excludeTools,
    })
    return true
  }

  /** Abort a running job (best-effort; the loop unwinds on the abort signal).
   *  A job still queued for a concurrency slot is marked cancelled so it bails
   *  out the moment its turn comes up. */
  async cancel(id: string): Promise<boolean> {
    const entry = this.running.get(id)
    if (!entry) {
      const rec = await this.load(id)
      if (rec && rec.status === 'queued') {
        rec.status = 'cancelled'
        rec.finishedAt = new Date().toISOString()
        rec.updatedAt = rec.finishedAt
        this.flush(rec)
        this.cancelledQueued.add(id)
        return true
      }
      return false
    }
    entry.rec.status = 'cancelled'
    this.touch(entry.rec)
    entry.ac.abort()
    return true
  }

  async remove(id: string): Promise<boolean> {
    const entry = this.running.get(id)
    if (entry) entry.ac.abort()
    // Prevent a queued (waiting-for-slot) run from starting after removal.
    this.cancelledQueued.add(id)
    this.live.delete(id)
    const existing = this.pendingSave.get(id)
    if (existing) clearTimeout(existing)
    this.stmtDelete.run(id)
    return true
  }

  /** Subscribe to a job's live events. Returns an unsubscribe function. */
  subscribe(id: string, cb: (ev: JobEvent) => void): () => void {
    let subs = this.live.get(id)
    if (!subs) {
      subs = new Set()
      this.live.set(id, subs)
    }
    subs.add(cb)
    return () => {
      subs!.delete(cb)
      if (subs!.size === 0) this.live.delete(id)
    }
  }

  // ---- run lifecycle ----

  private async runJob(rec: JobRecord, input: CreateJobInput): Promise<void> {
    const release = await this.acquire(rec.id)
    // The job may have been cancelled while it was queued for a slot — bail out
    // without starting the agent loop (the cancelled status was persisted by
    // `cancel()`).
    if (this.cancelledQueued.has(rec.id)) {
      this.cancelledQueued.delete(rec.id)
      release()
      return
    }
    rec.status = 'running'
    rec.startedAt = new Date().toISOString()
    this.touch(rec)
    const ac = new AbortController()
    this.running.set(rec.id, { ac, rec })

    const bus: RunEventBus = {
      emit: (event, payload) => this.onEvent(rec, event, payload),
    }

    try {
      // Resume re-runs from the persisted transcript; a fresh job starts from
      // the user prompt only.
      const messages: ChatMessage[] = rec.messages?.length
        ? rec.messages
        : [{ role: 'user', content: input.prompt }]
      const answer = await this.ctx.agent.run({
        messages,
        model: input.model,
        taskId: input.taskId,
        systemPrompt: input.systemPrompt,
        includeTools: input.includeTools,
        excludeTools: input.excludeTools,
        workspace: rec.workspace,
        // Background jobs run unattended: never block on human approval.
        skipApproval: true,
        // Long-running, multi-step pipelines default to PSE three-role mode,
        // even when interactive chat keeps the global PSE flag off.
        pse: true,
        signal: ac.signal,
        runId: `job-${rec.id}`,
        sessionId: rec.id,
        bus,
      })
      // `cancel()` mutates `rec.status` on this shared object from another async
      // context, so TS's local narrowing here is unsound — read the live status
      // through the map (which the cancel path also mutates) to defeat narrowing.
      if (this.statusOf(rec) !== 'cancelled') {
        rec.answer = answer
        rec.status = 'succeeded'
      }
    } catch (err) {
      if (ac.signal.aborted || this.statusOf(rec) === 'cancelled') {
        rec.status = 'cancelled'
      } else {
        rec.status = 'failed'
        rec.error = (err as Error).message
      }
    } finally {
      rec.finishedAt = new Date().toISOString()
      this.running.delete(rec.id)
      this.flush(rec)
      release()
      // Notify live subscribers of the terminal status change (a `done`-style
      // pseudo event lets the UI stop polling / mark the job finished).
      const subs = this.live.get(rec.id)
      if (subs) {
        const terminal: JobEvent = {
          seq: rec.events.length,
          type: 'done',
          answer: rec.answer ?? '',
        }
        for (const cb of subs) cb(terminal)
      }
    }
  }

  /** Live status read through the in-memory map so TS can't over-narrow it. */
  private statusOf(rec: JobRecord): JobStatus {
    return this.running.get(rec.id)?.rec.status ?? rec.status
  }

  private onEvent(rec: JobRecord, event: string, payload?: unknown): void {
    switch (event) {
      case 'agent/step': {
        const step = payload as AgentStep
        this.record(rec, { type: 'step', step })
        // Maintain the message transcript so a failed/interrupted job can be
        // resumed from where it left off (assistant turn + tool results).
        if (!rec.messages) rec.messages = []
        rec.messages.push(step.message)
        for (const tr of step.toolResults) {
          rec.messages.push({
            role: 'tool',
            tool_call_id: tr.call.id,
            name: tr.call.name,
            content: tr.result,
          })
        }
        return
      }
      case 'agent/tool-call':
        this.record(rec, { type: 'tool-call', call: payload as ToolCall })
        return
      case 'agent/tool-result': {
        const p = payload as { call: ToolCall; result: string; ok: boolean; durationMs: number }
        this.record(rec, { type: 'tool-result', ...p })
        return
      }
      case 'agent/tool-progress': {
        const p = payload as { id: string; chunk: string }
        this.record(rec, { type: 'tool-progress', ...p })
        return
      }
      case 'agent/approval-request':
        this.record(rec, { type: 'approval-request', call: payload as ToolCall })
        return
      case 'agent/delta':
        this.record(rec, { type: 'delta', text: payload as string })
        return
      case 'agent/reasoning':
        this.record(rec, { type: 'reasoning', text: payload as string })
        return
      case 'agent/done': {
        const p = payload as string | { answer: string; failedToolCalls: number }
        const answer = typeof p === 'string' ? p : p.answer
        const failedToolCalls = typeof p === 'string' ? 0 : p.failedToolCalls
        this.record(rec, { type: 'done', answer })
        rec.answer = answer
        if (failedToolCalls > 0 && rec.status === 'succeeded') {
          rec.status = 'failed'
          rec.error = `${failedToolCalls} tool call(s) failed`
        }
        return
      }
      case 'llm/usage': {
        const u = payload as {
          model: string
          promptTokens: number
          completionTokens: number
          cost: number
        }
        this.record(rec, { type: 'usage', record: u })
        rec.usage = {
          prompt: (rec.usage?.prompt ?? 0) + u.promptTokens,
          completion: (rec.usage?.completion ?? 0) + u.completionTokens,
          cost: (rec.usage?.cost ?? 0) + u.cost,
        }
        return
      }
      default:
        return
    }
  }

  private record(rec: JobRecord, ev: NewJobEvent): void {
    const entry = { seq: rec.events.length, ...ev } as JobEvent
    rec.events.push(entry)
    this.touch(rec)
    const subs = this.live.get(rec.id)
    if (subs) for (const cb of subs) cb(entry)
  }

  protected async stop(): Promise<void> {
    // Drain any debounced saves so nothing is lost on shutdown, then close the
    // SQLite handle to avoid leaking the file descriptor / WAL.
    const jobsToFlush = [...this.pendingSave.keys()].map((id) => this.running.get(id)?.rec)
    this.pendingSave.clear()
    for (const rec of jobsToFlush) {
      if (rec) await this.persist(rec).catch(() => {})
    }
    this.db.close()
  }
}

export const jobs = definePlugin(JobsService, 'jobs', ['agent'])
