/**
 * Shared bridge for invoking the Python PSE engines.
 *
 * Every `tool-*.ts` that shells out to a `*-pse` framework was repeating the
 * same five things: resolve the framework root (from its dedicated env var),
 * guard that `run.py` exists, spawn `uv run python run.py`, apply a
 * SIGTERM→SIGKILL timeout, and cap/forward stdout+stderr. This module owns
 * that once so the tools only describe what makes them different.
 *
 * Path resolution is env-driven only: each framework root comes from its own
 * environment variable (see `PSE_FRAMEWORK_ENVS`). No relative path into the
 * surrounding workspace is assumed — if the variable is unset the tool fails
 * fast with an actionable message instead of guessing a location.
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { writeFile, mkdtemp, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'

/** PSE frameworks reachable from this workspace. */
export const PSE_FRAMEWORKS = ['autogen', 'crewai', 'langgraph', 'llamaindex'] as const
export type PseFramework = (typeof PSE_FRAMEWORKS)[number]

/** Env var that points at each framework's root directory. */
export const PSE_FRAMEWORK_ENVS: Record<PseFramework, string> = {
  autogen: 'AUTOGEN_PSE_DIR',
  crewai: 'CREWAI_PSE_DIR',
  langgraph: 'LANGGRAPH_PSE_DIR',
  llamaindex: 'LLAMAINDEX_PSE_DIR',
}

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

/**
 * Root directory of a PSE framework, resolved from its dedicated env var.
 *
 * Throws if the variable is unset so misconfiguration surfaces immediately
 * with an actionable message, rather than a confusing `uv` stack trace later
 * (or a silently wrong path into the surrounding workspace).
 */
export function resolvePseDir(framework: PseFramework): string {
  const env = PSE_FRAMEWORK_ENVS[framework]
  const dir = process.env[env]
  if (!dir) {
    throw new Error(
      `${env} is not set. Export it to the absolute path of the ${framework}-pse framework root (e.g. in .env).`,
    )
  }
  return dir
}

/** Directory of a task inside a framework: `<framework>/tasks/<task>`. */
export function resolveTaskDir(framework: PseFramework, task: string): string {
  return join(resolvePseDir(framework), 'tasks', task)
}

/**
 * Absolutise a path argument a PSE tool received from the model.
 *
 * The model frequently fills a path parameter with the *documented* relative
 * form — `tasks/hot-news/news`, i.e. the path as seen from the framework root.
 * Using such a value verbatim breaks in two ways (observed 2026-09-10 with
 * `hot-news-fetch --out=tasks/hot-news/news`):
 *
 *   1. the tool echoes a bare relative path into the answer, and the answer
 *      prettifier can only linkify absolute (`/Users|/home|…`) paths — so the
 *      generated report showed up as dead text with no way to open it;
 *   2. the child process resolves it against its own cwd (the task dir),
 *      silently filing the snapshot under `<taskDir>/tasks/hot-news/news` — a
 *      fork of the corpus that run.py, the digest and the tools never read.
 *
 * Anchoring a relative value at `frameworkRoot` makes the documented form land
 * exactly on the canonical task directory. Absolute values pass through.
 *
 * `frameworkRoot` is a thunk on purpose: resolving it reads the framework's env
 * var, which is legitimately unset in tests/CI and for absolute-path-only runs.
 * Only a relative value may depend on it.
 */
export function absolutizeTaskPath(rawPath: string, frameworkRoot: () => string): string {
  return isAbsolute(rawPath) ? rawPath : resolvePath(frameworkRoot(), rawPath)
}

/**
 * Resolve a framework root without throwing when the env var is unset.
 *
 * Tool *descriptions* interpolate the default PSE output path at registration
 * time. Requiring the env just to register (and enumerate) tools breaks tool
 * listing in tests / CI where the framework isn't installed. Return `null`
 * here and let callers fall back to a display-only placeholder; the strict
 * {@link resolvePseDir} is still used at execution time so an actual run fails
 * fast with a clear message.
 */
export function resolvePseDirOrNull(framework: PseFramework): string | null {
  const dir = process.env[PSE_FRAMEWORK_ENVS[framework]]
  return dir && dir.length ? dir : null
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
  /** 跳过 uv 项目依赖同步（uv run --no-sync）。仅脚本依赖标准库/本地模块/已预装
   *  小依赖时开启（容器内 llamaindex-pse 的 playwright 在 musl-aarch64 无 wheel，
   *  同步整个 pyproject 必失败）。本地已有 .venv 时无副作用。 */
  noSync?: boolean
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
  /** 跳过 uv 项目依赖同步（uv run --no-sync）。脚本只依赖标准库/同目录本地模块时
   *  开启可避免容器内触发重量级 sync（如 playwright/llama-index 在 linux-musl-aarch64
   *  无 wheel）。本地已有 .venv 时无副作用。 */
  noSync?: boolean
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

/**
 * 为一次 uv 子进程计算环境变量。容器场景（Docker）下，PSE_UV_VENV_ROOT 设置时，
 * 把该项目的 uv venv 隔离到容器私有目录（/opt/pse-venvs/<项目名>），避免 Linux
 * .venv 写进共享挂载的宿主目录（否则会覆盖宿主机 macOS .venv，破坏本地 uv 环境）。
 * 本地（未设置 PSE_UV_VENV_ROOT）原样返回 baseEnv，行为不变。
 *
 * 项目名从 cwd 推断：优先取 /frameworks/<name>/ 段，其次取挂载仓库根下
 * /workspace/<...>/<app>/ 的最后一段（invest-kit 等分析项目），兜底 'default'。
 * 供 util-pse 的 spawnCapture 与直接调 uv 的工具（csv-analyze / product-analyze）共用。
 */
export function uvEnvFor(cwd: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const venvRoot = process.env.PSE_UV_VENV_ROOT
  if (!venvRoot || baseEnv.UV_PROJECT_ENVIRONMENT) return baseEnv
  let name = 'default'
  const fw = cwd.match(/\/frameworks\/([^/]+)\//)
  const app = cwd.match(/\/workspace\/[^/]+\/(?:apps\/)?([^/]+)(?:\/|$)/)
  if (fw) name = fw[1]
  else if (app) name = app[1]
  const env: NodeJS.ProcessEnv = { ...baseEnv, UV_PROJECT_ENVIRONMENT: join(venvRoot, name) }
  // 容器内：llamaindex-pse 未 editable 安装，需把框架 src 加进 PYTHONPATH，
  // 否则 run.py 的 `from llamaindex_pse.model import ...` 在 noSync 模式下找不到包。
  // 仅当 src 实际存在（容器挂载 /workspace）才注入，本地 macOS 不受影响。
  if (name === 'llamaindex-pse') {
    const src = '/workspace/frameworks/llamaindex-pse/src'
    try {
      if (statSync(src).isDirectory()) {
        env.PYTHONPATH = env.PYTHONPATH ? `${src}:${env.PYTHONPATH}` : src
      }
    } catch {
      // 本地环境无 /workspace 挂载，跳过注入
    }
  }
  return env
}

async function spawnCapture(
  opts: SpawnCaptureOptions,
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  const { tool, cwd, cmdArgs, timeoutMs, maxOutput, env, onProgress, logger } = opts
  logger('starting %s cwd=%s', cmdArgs.join(' '), cwd)
  let stdout = ''
  let stderr = ''
  try {
    const child = spawn('uv', cmdArgs, { cwd, env: uvEnvFor(cwd, env) })

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
    noSync = false,
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
    const env = PSE_FRAMEWORK_ENVS[framework]
    return {
      ok: false,
      error: `error: ${tool} — ${runFile} not found at ${run}. Check ${env} path.`,
    }
  }

  const log = logger ?? (() => {})
  const res = await spawnCapture({
    tool,
    cwd: taskDir,
    cmdArgs: ['run', ...(noSync ? ['--no-sync'] : []), 'python', run, ...args],
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
    noSync = false,
    onProgress,
    logger,
  } = options

  const res = await spawnCapture({
    tool,
    cwd,
    cmdArgs: ['run', ...(noSync ? ['--no-sync'] : []), 'python', script, ...args],
    timeoutMs,
    maxOutput,
    env: env ?? { ...process.env },
    onProgress,
    logger: logger ?? (() => {}),
  })
  if (!res.ok) return res
  return { ok: true, stdout: res.stdout, stderr: res.stderr, cwd }
}
