import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// …/resolve-studio/packages/core/src/plugins/tools →
// 8 levels up = ***REMOVED***. Override with CREWAI_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const CREWAI_PSE =
  process.env.CREWAI_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')
const RUN = join('tasks', 'project-articles', 'run.py')

// Article writing is a long multi-agent pipeline (Planner + Specialist +
// Evaluator + translation + grounding checks) — give it generous headroom.
// tax-agent-platform 等大项目 Planner 要读 10+ 文件，加上写作和翻译，
// 10 分钟容易超时；放宽到 20 分钟。
const RUN_TIMEOUT_MS = 1_200_000
const MAX_OUTPUT = 64 * 1024

const ZH_SAVED_RE = /中文已保存 →\s*(\S+)/
const EN_SAVED_RE = /英文已保存 →\s*(\S+)/

// Project keys are read from projects.json at registration time so the enum
// stays in sync without manual edits.
const PROJECTS_FILE = join(CREWAI_PSE, 'tasks', 'project-articles', 'projects.json')

// Loaded synchronously at module-eval so the `project` enum is populated in the
// tool schema at registration time. An async load would leave the enum empty,
// hiding the choices from the model and causing repeated no-project calls.
function loadProjectKeys(): string[] {
  try {
    const raw = readFileSync(PROJECTS_FILE, 'utf8')
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.keys(obj).sort()
  } catch {
    return []
  }
}

const projectKeys = loadProjectKeys()

const STYLE_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
type StyleLetter = (typeof STYLE_NAMES)[number]

export interface ArticleWriteConfig {
  /** Default model provider env to inherit. Currently crewai-pse reads its own .env. */
  _placeholder?: never
}

const registerArticleWrite = (ctx: Context, _config: ArticleWriteConfig = {}) => {
  ctx.tools.register({
    name: 'article-write',
    description:
      'Run the crewai-pse three-agent article pipeline (Planner/Specialist/Evaluator) ' +
      'to write a Chinese technical article about a project, then auto-translate to English. ' +
      'Takes 3-10 minutes and calls the LLM multiple times. Returns the full Chinese article ' +
      '(Markdown) and save paths. Use when the user asks to write / generate an article for a ' +
      'project. The project MUST be one from the enum (configured in crewai-pse projects.json). ' +
      'If the user did not specify a project, ASK the user to pick one of the `project` enum ' +
      'values (read them from the tool schema — do NOT call this tool to discover them), then ' +
      'call with `project` set. Never guess or invent a project name. This parameter is REQUIRED. ' +
      'CRITICAL: this tool produces EXACTLY ONE article for the SINGLE `project` given — ' +
      'never call it once per project, never loop over the enum, and never generate articles ' +
      'for multiple projects from a vague "write an article" request. If the user did not name ' +
      'a specific project, ask them to pick ONE, then call once. Only iterate across projects ' +
      'when the user explicitly says "write for all / every project". ' +
      'Default provider: free (default); set provider="deepseek" for paid higher quality. ' +
      'Do NOT read any files before calling this tool — all paths and configs are handled internally.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Project key from crewai-pse projects.json. This parameter is REQUIRED — pick one ' +
            'of the enum values. If the user has not specified a project, ask them to choose, ' +
            'then pass project=<key>.',
          enum: projectKeys.length ? projectKeys : undefined,
        },
        publish: {
          type: 'boolean',
          description: 'If true, auto-publish the article to WordPress after generation.',
          default: false,
        },
        style: {
          type: 'string',
          description:
            'Narrative style override A-F (F=engineering show-your-work). Omit for auto-rotation.',
          enum: [...STYLE_NAMES],
        },
        provider: {
          type: 'string',
          description:
            'Model provider: "free" (default, matches `make articles`) or "deepseek" (paid, higher quality, matches `make articles-paid`).',
          enum: ['free', 'deepseek'],
          default: 'free',
        },
      },
      required: ['project'],
    },
    async execute(
      args: { project?: string; publish?: boolean; style?: string; provider?: 'free' | 'deepseek' },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { project, publish = false, style, provider = 'free' } = args
      const onProgress = execCtx?.onProgress

      // If no project specified (shouldn't happen — `project` is required), ask
      // the user to choose instead of re-listing in a loop.
      if (!project) {
        if (projectKeys.length === 0) {
          return 'error: no projects configured in crewai-pse projects.json.'
        }
        return (
          'project 参数必填。可用项目见本工具的 project 枚举（crewai-pse projects.json 的 key）：\n' +
          projectKeys.map((k, i) => `${i + 1}. ${k}`).join('\n') +
          '\n\n请先让用户从中选一个，再带 project=<项目名> 调用本工具；不要反复不带 project 调用。'
        )
      }

      // Validate project against known keys (best-effort; empty list = skip check)
      if (projectKeys.length > 0 && !projectKeys.includes(project)) {
        return `error: unknown project "${project}". Available: ${projectKeys.join(', ')}`
      }

      const cmdArgs = ['run', 'python', RUN, project]
      if (publish) cmdArgs.push('--publish')
      if (style && STYLE_NAMES.includes(style as StyleLetter)) {
        cmdArgs.push(`--style=${style}`)
      }

      ctx
        .logger('article-write')
        .info(
          'starting project=%s publish=%s style=%s cwd=%s',
          project,
          publish,
          style ?? 'auto',
          CREWAI_PSE,
        )

      // Guard: verify the crewai-pse directory and run.py exist before spawning.
      // A missing cwd makes execFile throw with an unhelpful empty error.
      const runPath = join(CREWAI_PSE, RUN)
      try {
        await readFile(runPath)
      } catch {
        return `error: article-write — crewai-pse not found at ${CREWAI_PSE} (run.py missing). Check the path resolution in tool-article-write.ts.`
      }

      let stdout = ''
      let stderr = ''
      try {
        // Build child env explicitly to match `make articles` (free, default) vs
        // `make articles-paid` (deepseek). We cannot rely on inherited env vars
        // because the harness `.env` model name may differ from what crewai-pse
        // expects, and load_dotenv won't override.
        const childEnv: NodeJS.ProcessEnv = { ...process.env }
        delete childEnv.OPENAI_MODEL
        delete childEnv.OPENAI_BASE_URL
        delete childEnv.OPENAI_API_KEY
        if (provider === 'deepseek') {
          // crewai-pse/.env carries deepseek creds; load_dotenv will pick them up.
          ctx.logger('article-write').info('provider=deepseek (paid)')
        } else {
          // free: use the harness's standard OpenAI-compatible creds from `.env`
          // (OPENAI_*); no vendor-specific model prefix or private gateway.
          childEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
          childEnv.OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
          childEnv.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? ''
          ctx.logger('article-write').info('provider=free (default)')
        }
        const { out, err } = await spawnStream('uv', cmdArgs, {
          cwd: CREWAI_PSE,
          timeoutMs: RUN_TIMEOUT_MS,
          onProgress,
          env: childEnv,
        })
        stdout = out
        stderr = err
      } catch (err) {
        const e = err as { message?: string; code?: string; stdout?: string; stderr?: string }
        const detail = e.stdout?.trim() || e.stderr?.trim() || e.message || e.code || String(err)
        return `error: article-write failed (${e.code ?? 'unknown'}) — ${truncate(detail, 1200)}`
      }

      // Extract saved article paths
      const zhMatch = ZH_SAVED_RE.exec(stdout)
      const enMatch = EN_SAVED_RE.exec(stdout)

      const parts: string[] = []
      parts.push(`> crewai-pse article generated for project: **${project}**`)
      if (zhMatch?.[1]) parts.push(`> Chinese: ${zhMatch[1]}`)
      if (enMatch?.[1]) parts.push(`> English: ${enMatch[1]}`)
      if (publish) parts.push('> Auto-published to WordPress.')

      // Read and return the Chinese article if available
      if (zhMatch?.[1]) {
        try {
          const article = await readFile(zhMatch[1], { encoding: 'utf8' })
          parts.push('', truncate(article, MAX_OUTPUT - parts.join('\n').length - 100))
        } catch {
          parts.push('', '(could not read article file; check the path above)')
        }
      } else {
        // Fallback: return tail of stdout so the user can see what happened
        parts.push('', '--- stdout tail ---', truncate(stdout.slice(-3000), 3000))
        if (stderr.trim()) {
          parts.push('', '--- stderr tail ---', truncate(stderr.slice(-1000), 1000))
        }
      }

      return parts.join('\n')
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

interface SpawnStreamOptions {
  cwd: string
  timeoutMs: number
  onProgress?: (chunk: string) => void
  env?: NodeJS.ProcessEnv
}

/**
 * Spawn a process and stream stdout/stderr in real time. Returns the full
 * accumulated stdout/stderr when the process exits. Each stdout line is also
 * forwarded to `onProgress` so the UI can show live progress.
 */
function spawnStream(
  cmd: string,
  args: string[],
  opts: SpawnStreamOptions,
): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      // Give it 5s to die gracefully, then SIGKILL
      setTimeout(() => child.kill('SIGKILL'), 5000)
      reject(new Error(`timeout after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      out += text
      opts.onProgress?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      err += text
      // Also surface stderr as progress so errors are visible in real time
      opts.onProgress?.(text)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ out, err })
      } else {
        reject(
          Object.assign(new Error(`process exited with code ${code}`), {
            code,
            stdout: out,
            stderr: err,
          }),
        )
      }
    })
  })
}

export const toolArticleWrite = definePlugin(registerArticleWrite, 'tool-article-write', ['tools'])
