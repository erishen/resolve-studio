import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'
import { resolvePseDir, runPseTask, MAX_OUTPUT, gateNonFreeProvider } from './util-pse.js'

const CREWAI_PSE = resolvePseDir('crewai')
const RUN = join('tasks', 'project-articles', 'run.py')

// Article writing is a long multi-agent pipeline (Planner + Specialist +
// Evaluator + translation + grounding checks) — give it generous headroom.
// tax-agent-platform 等大项目 Planner 要读 10+ 文件，加上写作和翻译，
// 10 分钟容易超时；放宽到 20 分钟。
const RUN_TIMEOUT_MS = 1_200_000

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

/**
 * Build the child env for crewai-pse's `run.py`, matching `make articles`
 * (free, default) vs `make articles-paid` (deepseek).
 *
 * We cannot rely on inherited env vars because the harness `.env` model name
 * may differ from what crewai-pse expects, and load_dotenv won't override. So
 * we fork the env and either strip the `OPENAI_*` trio (let crewai-pse/.env's
 * own deepseek creds take over via cwd-based load_dotenv) or pin it to the
 * harness's OpenAI-compatible creds.
 */
function buildRunEnv(provider: 'free' | 'deepseek'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.OPENAI_MODEL
  delete env.OPENAI_BASE_URL
  delete env.OPENAI_API_KEY
  if (provider === 'deepseek') {
    // crewai-pse/.env carries deepseek creds; load_dotenv will pick them up.
  } else {
    env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
    env.OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
    env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? ''
  }
  return env
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
      'If the user did not specify a project, call this tool WITHOUT `project` to list the ' +
      'candidates, let the user pick ONE, then call again WITH `project` set. Do NOT guess or ' +
      'invent a project name, and NEVER loop over the enum to write multiple articles at once. ' +
      'CRITICAL: this tool produces EXACTLY ONE article for the SINGLE `project` given — ' +
      'never call it once per project, never loop over the enum, and never generate articles ' +
      'for multiple projects from a vague "write an article" request. If the user did not name ' +
      'a specific project, ask them to pick ONE, then call once. Only iterate across projects ' +
      'when the user explicitly says "write for all / every project". ' +
      'Default provider: free (default); set provider="deepseek" for paid higher quality. ' +
      'Switching to provider="deepseek" (PAID) triggers a human approval prompt — wait for the user ' +
      'to approve before assuming it will run; if the user rejects, do NOT retry with deepseek, ' +
      'explain and adjust instead. ' +
      'Do NOT read any files before calling this tool — all paths and configs are handled internally.',
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Project key from crewai-pse projects.json. Omit it (call WITHOUT `project`) to get ' +
            'the candidate list; once the user picks one, pass project=<key> to write that single ' +
            'article. Never guess or invent a project name.',
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
      // `project` is intentionally NOT required: a vague "write an article" request
      // should route through the no-project branch (returns the candidate list) so the
      // model lets the USER pick ONE instead of guessing or looping over the enum.
      required: [],
    },
    // Paid (deepseek) runs hit a human-in-the-loop approval gate; free runs pass
    // through. This is what gives the user a choice before spending money.
    approvalWhen: gateNonFreeProvider('free'),
    async execute(
      args: { project?: string; publish?: boolean; style?: string; provider?: 'free' | 'deepseek' },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { project, publish = false, style, provider = 'free' } = args
      const onProgress = execCtx?.onProgress

      // If no project specified, return the candidate list so the user can choose
      // ONE — this is the intended "pick a project" flow, not a re-list loop.
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

      const runArgs = [project]
      if (publish) runArgs.push('--publish')
      if (style && STYLE_NAMES.includes(style as StyleLetter)) {
        runArgs.push(`--style=${style}`)
      }

      ctx
        .logger('article-write')
        .info(
          'starting project=%s publish=%s style=%s provider=%s cwd=%s',
          project,
          publish,
          style ?? 'auto',
          provider,
          CREWAI_PSE,
        )

      // cwd stays at the crewai-pse root (matches the original `make articles`),
      // with run.py addressed relative to it. runPseTask builds the final
      // `uv run python <taskDir>/<runFile>` command and forks `env` for the
      // free/deepseek provider switch.
      const res = await runPseTask({
        tool: 'article-write',
        framework: 'crewai',
        task: 'project-articles',
        runFile: RUN,
        taskDir: CREWAI_PSE,
        args: runArgs,
        env: buildRunEnv(provider),
        timeoutMs: RUN_TIMEOUT_MS,
        onProgress,
        logger: (msg, ...a) => ctx.logger('article-write').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const { stdout, stderr } = res

      // Extract saved article paths
      const zhMatch = ZH_SAVED_RE.exec(stdout)
      const enMatch = EN_SAVED_RE.exec(stdout)

      // run.py prints ABSOLUTE save paths (ARTICLES_DIR in crewai-pse/.env is an
      // absolute path), so they already match the Web UI preview regex
      // (/Users/.../file.md) and render as clickable preview buttons. Pass them
      // through unchanged. If a future run mode ever emits a relative path we
      // leave it as-is (no preview) instead of guessing a wrong base.
      const toAbs = (p?: string): string | undefined => p ?? undefined
      const zhPath = toAbs(zhMatch?.[1])
      const enPath = toAbs(enMatch?.[1])

      const parts: string[] = []
      parts.push(`> crewai-pse article generated for project: **${project}**`)
      if (zhPath) parts.push(`> Chinese: ${zhPath}`)
      if (enPath) parts.push(`> English: ${enPath}`)
      if (publish) parts.push('> Auto-published to WordPress.')

      // Read and return the Chinese article if available
      if (zhPath) {
        try {
          const article = await readFile(zhPath, { encoding: 'utf8' })
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

export const toolArticleWrite = definePlugin(registerArticleWrite, 'tool-article-write', ['tools'])
