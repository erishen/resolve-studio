/**
 * Shared bridge for invoking the Python PSE engines.
 *
 * Every `tool-*.ts` that shells out to a `*-pse` framework was repeating the
 * same five things: resolve the framework root (env override + 8-levels-up
 * fallback), guard that `run.py` exists, spawn `uv run python run.py`, apply a
 * SIGTERM→SIGKILL timeout, and cap/forward stdout+stderr. This module owns
 * that once so the tools only describe what makes them different.
 *
 * Path resolution: this file lives in
 * `…/resolve-studio/packages/core/src/plugins/tools`, so 8 levels up is the
 * workspace root that hosts `frameworks/`.
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdtemp, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** PSE frameworks reachable from this workspace. */
export const PSE_FRAMEWORKS = ['autogen', 'crewai', 'langgraph', 'llamaindex'] as const
export type PseFramework = (typeof PSE_FRAMEWORKS)[number]

/** Env var + default location for each framework. */
const FRAMEWORK_DIRS: Record<PseFramework, { env: string; rel: string }> = {
  autogen: { env: 'AUTOGEN_PSE_DIR', rel: '***REMOVED***' },
  crewai: { env: 'CREWAI_PSE_DIR', rel: '***REMOVED***' },
  langgraph: { env: 'LANGGRAPH_PSE_DIR', rel: '***REMOVED***' },
  llamaindex: { env: 'LLAMAINDEX_PSE_DIR', rel: '***REMOVED***' },
}

// 8 levels up from …/plugins/tools = the workspace root, the directory that
// hosts `frameworks/`. Written as a repeat so the depth is unambiguous (the
// old copy-pasted literal was easy to miscount).
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(HERE, '../'.repeat(8))

/** Default cap for accumulated stdout/stderr (64 KiB). */
export const MAX_OUTPUT = 64 * 1024
/** Default per-run budget for a PSE pipeline (5 min). */
export const DEFAULT_RUN_TIMEOUT_MS = 300_000

/**
 * Approval gate for a PSE tool's provider switch: any explicit provider other
 * than the tool's free default (e.g. deepseek / scnet-* paid gateways) requires
 * human approval, so the user consents before a paid LLM run. Omitted provider
 * (free default) passes through ungated.
 */
export function gateNonFreeProvider(freeProvider: string) {
  return (args: Record<string, unknown>): boolean =>
    args.provider !== undefined && args.provider !== freeProvider
}

/** Root directory of a PSE framework, honouring its env override. */
export function resolvePseDir(framework: PseFramework): string {
  const { env, rel } = FRAMEWORK_DIRS[framework]
  return process.env[env] ?? resolve(WORKSPACE_ROOT, rel)
}

/** Directory of a task inside a framework: `<framework>/tasks/<task>`. */
export function resolveTaskDir(framework: PseFramework, task: string): string {
  return join(resolvePseDir(framework), 'tasks', task)
}

export interface RunPseTaskOptions {
  /** Tool name — prefixes logs and every error message. */
  tool: string
  /** Framework hosting the task. */
  framework: PseFramework
  /** Task directory name under `<framework>/tasks/`. */
  task: string
  /** Extra CLI args appended after `uv run python run.py`. */
  args?: string[]
  /** Run file name inside the task dir. Default `run.py`. */
  runFile?: string
  /** Override the resolved task directory (for tasks nested differently). */
  taskDir?: string
  /** Timeout in ms before SIGTERM (then SIGKILL 5s later). */
  timeoutMs?: number
  /**
   * Cap for accumulated stdout/stderr (defaults to `MAX_OUTPUT`). PSE tools
   * that parse a saved-path line out of stdout should raise this (e.g. to match
   * the original `execFile` `maxBuffer`) so the marker is never truncated away.
   */
  maxOutput?: number
  /**
   * Custom process environment. Defaults to a copy of `process.env`.
   * PSE tools need this to switch providers (e.g. free vs deepseek) by
   * overriding/removing `OPENAI_*` before spawning the pipeline.
   */
  env?: NodeJS.ProcessEnv
  /** Progress sink, usually `execCtx.onProgress`. */
  onProgress?: (chunk: string) => void
  /** Logger for the start line, usually `ctx.logger(tool).info`. */
  logger?: (msg: string, ...args: unknown[]) => void
}

export type PseRunResult =
  | { ok: true; stdout: string; stderr: string; taskDir: string; run: string }
  | { ok: false; error: string }

/**
 * Persist a text blob to a temp file and return its path.
 *
 * PSE pipelines take file paths rather than inline text for large inputs
 * (JD text, resume text), so tools stage them in a temp dir first.
 */
export async function writeTempText(
  prefix: string,
  filename: string,
  content: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const path = join(dir, filename)
  await writeFile(path, content, 'utf8')
  return path
}

/** Result of running any task-dir Python script via `uv`. */
export type PseScriptResult =
  { ok: true; stdout: string; stderr: string; cwd: string } | { ok: false; error: string }

/** Options for {@link runPseScript} — runs any script in an arbitrary cwd. */
export interface RunPseScriptOptions {
  /** Tool name — prefixes logs and every error message. */
  tool: string
  /** Absolute path to the Python script (e.g. `<taskDir>/fetch_news.py`). */
  script: string
  /** Working directory for the spawned process (usually the task dir). */
  cwd: string
  /** Extra CLI args appended after `uv run python <script>`. */
  args?: string[]
  /** Timeout in ms before SIGTERM (then SIGKILL 5s later). */
  timeoutMs?: number
  /** Cap for accumulated stdout/stderr (defaults to `MAX_OUTPUT`). */
  maxOutput?: number
  /** Custom process environment (defaults to a copy of `process.env`). */
  env?: NodeJS.ProcessEnv
  /** Progress sink, usually `execCtx.onProgress`. */
  onProgress?: (chunk: string) => void
  /** Logger for the start line. */
  logger?: (msg: string, ...args: unknown[]) => void
}

interface SpawnCaptureOptions {
  tool: string
  cwd: string
  cmdArgs: string[]
  timeoutMs: number
  maxOutput: number
  env: NodeJS.ProcessEnv
  onProgress?: (chunk: string) => void
  logger: (msg: string, ...args: unknown[]) => void
}

/** Shared `uv run python` child process: spawn, SIGTERM→SIGKILL timeout, capped output. */
async function spawnCapture(
  opts: SpawnCaptureOptions,
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  const { tool, cwd, cmdArgs, timeoutMs, maxOutput, env, onProgress, logger } = opts
  logger('starting %s cwd=%s', cmdArgs.join(' '), cwd)
  let stdout = ''
  let stderr = ''
  try {
    const child = spawn('uv', cmdArgs, { cwd, env })

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, timeoutMs)

    const collect = (sink: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString()
      if (sink === 'stdout') {
        stdout += text
        if (stdout.length > maxOutput) stdout = stdout.slice(-maxOutput)
      } else {
        stderr += text
        if (stderr.length > maxOutput) stderr = stderr.slice(-maxOutput)
      }
      onProgress?.(text)
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))

    const code = await new Promise<number>((done) => {
      child.on('close', done)
      child.on('error', () => done(-1))
    })
    clearTimeout(timeout)

    if (code !== 0) {
      const tail = stderr.slice(-500) || stdout.slice(-500)
      return { ok: false, error: `error: ${tool} exited with code ${code}\n${tail}` }
    }
  } catch (e) {
    return { ok: false, error: `error: ${tool} spawn failed: ${(e as Error).message}` }
  }

  return { ok: true, stdout, stderr }
}

/**
 * Run `<framework>/tasks/<task>/run.py` via `uv` and capture its output.
 *
 * Returns a discriminated union so callers can early-return `res.error`
 * (already prefixed with `error: <tool> — …`) without re-wrapping messages.
 */
export async function runPseTask(options: RunPseTaskOptions): Promise<PseRunResult> {
  const {
    tool,
    framework,
    task,
    args = [],
    runFile = 'run.py',
    taskDir: taskDirOverride,
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    maxOutput = MAX_OUTPUT,
    env,
    onProgress,
    logger,
  } = options

  const taskDir = taskDirOverride ?? resolveTaskDir(framework, task)
  const childEnv = env ?? { ...process.env }
  const run = join(taskDir, runFile)

  // Guard: fail fast with an actionable message rather than a uv stack trace.
  try {
    await readFile(run)
  } catch {
    const { env } = FRAMEWORK_DIRS[framework]
    return {
      ok: false,
      error: `error: ${tool} — ${runFile} not found at ${run}. Check ${env} path.`,
    }
  }

  const log = logger ?? (() => {})
  const res = await spawnCapture({
    tool,
    cwd: taskDir,
    cmdArgs: ['run', 'python', run, ...args],
    timeoutMs,
    maxOutput,
    env: childEnv,
    onProgress,
    logger: (msg, ...a) => {
      log(`framework=%s task=%s args=%s ${msg}`, framework, task, args.join(' '), ...a)
    },
  })
  if (!res.ok) return res
  return { ok: true, stdout: res.stdout, stderr: res.stderr, taskDir, run }
}

/**
 * Run any Python script (not just `<task>/run.py`) via `uv` in a given cwd and
 * capture its output. Tools that need a script other than the single shared
 * `run.py` entrypoint (companion scripts, listing tasks, platform publishers)
 * use this instead.
 */
export async function runPseScript(options: RunPseScriptOptions): Promise<PseScriptResult> {
  const {
    tool,
    script,
    cwd,
    args = [],
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
    maxOutput = MAX_OUTPUT,
    env,
    onProgress,
    logger,
  } = options

  const res = await spawnCapture({
    tool,
    cwd,
    cmdArgs: ['run', 'python', script, ...args],
    timeoutMs,
    maxOutput,
    env: env ?? { ...process.env },
    onProgress,
    logger: logger ?? (() => {}),
  })
  if (!res.ok) return res
  return { ok: true, stdout: res.stdout, stderr: res.stderr, cwd }
}
