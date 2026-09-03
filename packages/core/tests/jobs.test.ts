/**
 * Jobs service tests: detached long-running agent runs.
 *
 * Covers the service-level lifecycle (create → running → succeeded / cancelled,
 * with the event log persisted to disk) plus the web-server HTTP surface
 * (POST /api/jobs, GET /api/jobs, GET /api/jobs/:id, stream snapshot).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { AgentService } from '../src/services/agent.js'
import { LlmService } from '../src/services/llm.js'
import { FastPathService } from '../src/services/fastpath.js'
import { ApprovalService } from '../src/services/approval.js'
import { UsageService } from '../src/services/usage.js'
import { FsRootsService } from '../src/services/fs-roots.js'
import { skills } from '../src/plugins/skills.js'
import { tasks as tasksPlugin } from '../src/plugins/tasks.js'
import { mcpPlugin } from '../src/plugins/mcp.js'
import { llmMock } from '../src/plugins/llm-mock.js'
import { toolEcho } from '../src/plugins/tools/tool-echo.js'
import { jobs as jobsPlugin, type JobRecord } from '../src/services/jobs.js'
import { toolWriteFile } from '../src/plugins/tools/tool-write-file.js'
import { webServer } from '../src/plugins/web-server.js'
import { definePlugin } from '../src/plugins/util.js'
import pse from '@resolve-studio/plugin-pse'

const TMP_DIR = mkdtempSync(join(tmpdir(), 'resolve-studio-jobs-'))

// AgentService.inject requires a skills dir; give it a minimal empty one.
const TMP_SKILLS = mkdtempSync(join(tmpdir(), 'resolve-studio-jobs-skills-'))
mkdirSync(join(TMP_SKILLS, 'code-review'), { recursive: true })
writeFileSync(
  join(TMP_SKILLS, 'code-review', 'SKILL.md'),
  '---\nname: code-review\ndescription: 审查代码改动\n---\n# Code Review\n步骤...\n',
)

/** A deliberately slow tool so tests can cancel a job mid-run. */
const slowTool = definePlugin(
  (ctx: Context): void => {
    ctx.tools.register({
      name: 'slow-sleep',
      description: 'Sleep for a while.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        await new Promise((r) => setTimeout(r, 3000))
        return 'slept'
      },
    })
  },
  'tool-slow-sleep',
  ['tools'],
)

/** A gated tool: with skipApproval it must run without a human approval gate. */
const gatedTool = definePlugin(
  (ctx: Context): void => {
    ctx.tools.register({
      name: 'gated-tool',
      description: 'A tool that normally requires human approval.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return 'gated-ok'
      },
      needsApproval: true,
    })
  },
  'tool-gated',
  ['tools'],
)

async function buildContext(opts: { slow?: boolean; gated?: boolean } = {}): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(UsageService)
  // Job workspaces live under TMP_DIR, so the write root must include it for
  // write-file tests to land there.
  await root.plugin(FsRootsService, {
    readRoots: [TMP_DIR, process.cwd()],
    writeRoots: [TMP_DIR, process.cwd()],
    shellRoots: [TMP_DIR, process.cwd()],
  })
  await root.plugin(skills, { dir: TMP_SKILLS })
  await root.plugin(tasksPlugin)
  await root.plugin(mcpPlugin)
  await root.plugin(llmMock, {
    tool: opts.gated ? 'gated-tool' : opts.slow ? 'slow-sleep' : 'echo',
  })
  await root.plugin(toolEcho)
  await root.plugin(toolWriteFile)
  if (opts.slow) await root.plugin(slowTool)
  if (opts.gated) await root.plugin(gatedTool)
  await root.plugin(jobsPlugin, { dir: TMP_DIR })
  return root
}

/** Poll until the job truly ends (terminal status AND finishedAt set), or fail. */
async function waitForTerminal(root: Context, id: string, timeoutMs = 8000): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs
  const jobs = root.get('jobs') as unknown as { get(id: string): Promise<JobRecord | null> }
  for (;;) {
    const rec = await jobs.get(id)
    if (rec && rec.finishedAt) return rec
    if (Date.now() > deadline) assert.fail(`job ${id} did not finish in time (${rec?.status})`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('job runs to completion and persists its event log', async () => {
  const root = await buildContext()
  const jobs = root.get('jobs') as unknown as {
    create(i: { prompt: string; taskId?: string }): Promise<JobRecord>
    get(id: string): Promise<JobRecord | null>
    list(): Promise<{ id: string; status: string }[]>
  }
  assert.ok(jobs, 'jobs service should be registered')

  const created = await jobs.create({ prompt: '你好', taskId: 'articles' })
  // The run starts detached, so by the time create() resolves it may already be
  // 'running' — it must never be terminal yet.
  assert.ok(created.status === 'queued' || created.status === 'running')
  assert.equal(created.taskId, 'articles')

  const rec = await waitForTerminal(root, created.id)
  assert.equal(rec.status, 'succeeded')
  assert.ok(rec.answer && rec.answer.length > 0, 'job should carry a final answer')
  assert.ok(rec.startedAt && rec.finishedAt, 'job should record start/finish timestamps')
  assert.ok(
    rec.events.some((e) => e.type === 'tool-call'),
    'event log should contain tool-call',
  )
  assert.ok(
    rec.events.some((e) => e.type === 'done'),
    'event log should end with done',
  )
  // seq is monotonic across the log.
  rec.events.forEach((e, i) => assert.equal(e.seq, i))

  // Persisted to disk: a fresh read (same dir) returns the same data.
  const fromDisk = await jobs.get(created.id)
  assert.equal(fromDisk?.status, 'succeeded')

  const list = await jobs.list()
  assert.ok(list.some((j) => j.id === created.id && j.status === 'succeeded'))

  await root.fiber.dispose()
})

test('cancel aborts a running job and marks it cancelled', async () => {
  const root = await buildContext({ slow: true })
  const jobs = root.get('jobs') as unknown as {
    create(i: { prompt: string }): Promise<JobRecord>
    cancel(id: string): Promise<boolean>
    get(id: string): Promise<JobRecord | null>
  }
  const created = await jobs.create({ prompt: '跑慢点' })
  // Give the run a beat to start, then cancel mid-tool.
  await new Promise((r) => setTimeout(r, 150))
  const ok = await jobs.cancel(created.id)
  assert.equal(ok, true)

  const rec = await waitForTerminal(root, created.id)
  assert.equal(rec.status, 'cancelled')
  assert.ok(rec.finishedAt)

  await root.fiber.dispose()
})

test('jobs get a dedicated workspace and skip the approval gate', async () => {
  const root = await buildContext({ gated: true })
  const jobs = root.get('jobs') as unknown as {
    create(i: { prompt: string; includeTools?: string[] }): Promise<JobRecord>
    get(id: string): Promise<JobRecord | null>
  }

  const created = await jobs.create({
    prompt: '跑一个需要审批的工具',
    includeTools: ['gated-tool'],
  })
  // Workspace is created eagerly and persisted on the record.
  assert.ok(created.workspace, 'job should carry a workspace path')
  assert.ok(created.workspace!.startsWith(TMP_DIR), 'workspace lives under the jobs dir')

  const rec = await waitForTerminal(root, created.id)
  assert.equal(rec.status, 'succeeded')
  // skipApproval: the gated tool ran without an approval request.
  assert.ok(
    !rec.events.some((e) => e.type === 'approval-request'),
    'background jobs must not emit approval-request',
  )
  // Tool whitelist is persisted on the record.
  assert.deepEqual(rec.includeTools, ['gated-tool'])
  // Message transcript accumulated for resume.
  assert.ok(
    rec.messages && rec.messages.some((m) => m.role === 'tool'),
    'transcript should contain tool turns',
  )

  await root.fiber.dispose()
})

test('write-file anchors relative paths to the job workspace', async () => {
  const root = await buildContext()
  const jobs = root.get('jobs') as unknown as { create(i: { prompt: string }): Promise<JobRecord> }
  const created = await jobs.create({ prompt: '在工作区写一个文件' })
  const ws = created.workspace!
  // A job's tool execution forwards `workspace`; a relative write must land in
  // the workspace, not the default sandbox/ dir.
  const result = await root.tools.call(
    'write-file',
    { path: 'report.md', content: 'hello' },
    { workspace: ws },
  )
  assert.ok(result.includes('report.md'), result)
  assert.equal(readFileSync(join(ws, 'report.md'), 'utf8'), 'hello')

  await root.fiber.dispose()
})

test('resume re-runs from the transcript with the same workspace', async () => {
  const root = await buildContext({ slow: true })
  const jobs = root.get('jobs') as unknown as {
    create(i: { prompt: string }): Promise<JobRecord>
    cancel(id: string): Promise<boolean>
    resume(id: string, instruction?: string): Promise<boolean>
    get(id: string): Promise<JobRecord | null>
  }

  // Start a job, cancel it mid-run, then resume it.
  const created = await jobs.create({ prompt: '跑一半就被打断' })
  await new Promise((r) => setTimeout(r, 150))
  await jobs.cancel(created.id)
  const cancelled = await waitForTerminal(root, created.id)
  assert.equal(cancelled.status, 'cancelled')
  const workspace = cancelled.workspace
  assert.ok(workspace)

  // Resume: transcript already contains the slow tool result, so the mock LLM
  // answers immediately on the next run → fast completion on the same workspace.
  const resumed = await jobs.resume(created.id, '继续完成')
  assert.equal(resumed, true)
  const rec = await waitForTerminal(root, created.id)
  assert.equal(rec.status, 'succeeded')
  assert.equal(rec.workspace, workspace, 'resume reuses the same workspace')
  assert.ok(rec.messages!.some((m) => m.role === 'user' && m.content === '继续完成'))

  await root.fiber.dispose()
})

test('maxConcurrent queues excess jobs until a slot frees', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse)
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(UsageService)
  await root.plugin(FsRootsService, {
    readRoots: [TMP_DIR, process.cwd()],
    writeRoots: [TMP_DIR, process.cwd()],
    shellRoots: [TMP_DIR, process.cwd()],
  })
  await root.plugin(skills, { dir: TMP_SKILLS })
  await root.plugin(tasksPlugin)
  await root.plugin(mcpPlugin)
  await root.plugin(llmMock, { tool: 'slow-sleep' })
  await root.plugin(slowTool)
  await root.plugin(jobsPlugin, { dir: TMP_DIR, maxConcurrent: 1 })

  const jobs = root.get('jobs') as unknown as {
    create(i: { prompt: string }): Promise<JobRecord>
    get(id: string): Promise<JobRecord | null>
  }

  // With maxConcurrent=1, the second job must wait (stay queued) while the
  // first slow job holds the only slot.
  const a = await jobs.create({ prompt: '第一个慢任务' })
  const b = await jobs.create({ prompt: '第二个任务' })

  // Give the first run a moment to grab the slot; the second is still queued.
  await new Promise((r) => setTimeout(r, 200))
  const bRec = await jobs.get(b.id)
  assert.equal(bRec?.status, 'queued', 'second job waits for a slot')

  // Once `a` finishes (slow-sleep ~3s), `b` runs and completes.
  await waitForTerminal(root, a.id)
  const bDone = await waitForTerminal(root, b.id)
  assert.equal(bDone.status, 'succeeded')

  await root.fiber.dispose()
})

// ---- web-server surface ----
const PORT = 8898
const BASE = `http://127.0.0.1:${PORT}`

test('POST/GET /api/jobs and stream snapshot', async () => {
  const root = await buildContext()
  await root.plugin(webServer, { host: '127.0.0.1', port: PORT })
  await new Promise((r) => setTimeout(r, 300))

  const createdRes = await fetch(`${BASE}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '你好', taskId: 'investment', name: '测试任务' }),
  })
  assert.equal(createdRes.status, 200)
  const created = (await createdRes.json()) as { job: JobRecord }
  assert.ok(created.job.id)
  assert.equal(created.job.name, '测试任务')
  assert.equal(created.job.taskId, 'investment')

  // list contains it
  const list = (await (await fetch(`${BASE}/api/jobs`)).json()) as {
    jobs: { id: string }[]
  }
  assert.ok(list.jobs.some((j) => j.id === created.job.id))

  // wait for completion, then read detail
  const rec = await waitForTerminal(root, created.job.id)
  assert.equal(rec.status, 'succeeded')

  const detail = (await (await fetch(`${BASE}/api/jobs/${created.job.id}`)).json()) as {
    job: JobRecord
  }
  assert.equal(detail.job.status, 'succeeded')
  assert.ok(detail.job.events.length > 0)

  // stream returns the snapshot (terminal job → snapshot then close)
  const streamRes = await fetch(`${BASE}/api/jobs/${created.job.id}/stream`)
  assert.equal(streamRes.status, 200)
  const text = await streamRes.text()
  assert.ok(text.includes('event: snapshot'), 'stream should start with a snapshot')
  assert.ok(text.includes(`"status":"succeeded"`))

  // files: the workspace exists (empty for the echo job) and answers 200.
  const filesRes = await fetch(`${BASE}/api/jobs/${created.job.id}/files`)
  assert.equal(filesRes.status, 200)
  const files = (await filesRes.json()) as { files: { path: string; size: number }[] }
  assert.ok(Array.isArray(files.files))

  await root.fiber.dispose()
})

test('jobs force PSE mode even when the global PSE flag is off', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  // PSE plugin registered WITHOUT the `enabled` flag (defaults to off) — jobs
  // must still run in PSE three-role mode via the per-run `pse: true` override.
  await root.plugin(pse, {
    soulsDir: join(import.meta.dirname, 'fixtures', 'souls'),
  })
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(UsageService)
  await root.plugin(FsRootsService, {
    readRoots: [TMP_DIR, process.cwd()],
    writeRoots: [TMP_DIR, process.cwd()],
    shellRoots: [TMP_DIR, process.cwd()],
  })
  await root.plugin(skills, { dir: TMP_SKILLS })
  await root.plugin(tasksPlugin)
  await root.plugin(mcpPlugin)
  await root.plugin(toolEcho)

  // Capture the system prompts the agent sends, so we can assert the PSE
  // discipline block made it in for job runs.
  const seenPrompts: string[] = []
  class CaptureLlm extends LlmService {
    async chat(messages: { role: string; content: unknown }[]) {
      for (const m of messages) {
        if (m.role === 'system' && typeof m.content === 'string') seenPrompts.push(m.content)
      }
      return { content: 'done' }
    }
    async models() {
      return []
    }
  }
  await root.plugin(CaptureLlm)
  await root.plugin(jobsPlugin, { dir: TMP_DIR })

  const jobs = root.get('jobs') as unknown as { create(i: { prompt: string }): Promise<JobRecord> }
  const created = await jobs.create({ prompt: '把热点整理成报告' })
  await waitForTerminal(root, created.id)

  assert.ok(
    seenPrompts.some((p) => p.includes('PSE 三角色工作流')),
    'job run should inject the PSE three-role system prompt',
  )

  await root.fiber.dispose()
})
