import { dirname, join, resolve, basename } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'
import { resolvePseDir, runPseTask, MAX_OUTPUT } from './util-pse.js'

// This file lives in …/resolve-studio/packages/core/src/plugins/tools.
// 5 levels up = resolve-studio root (for the sandbox preview copy). Override
// with RESOLVE_STUDIO_DIR.
const HERE = dirname(fileURLToPath(import.meta.url))

const PREPARE = join('tasks', 'portfolio-review', 'prepare.py')
const RUN = join('tasks', 'portfolio-review', 'run.py')

// prepare re-runs analysis-lens `make calculate` (≤120s); run.py runs the full
// PSE team (planner/specialist/evaluator + knowledge retrieval, streaming) —
// give each step generous timeouts.
const PREPARE_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 480_000
// Match the original `execFile` maxBuffer (4 MiB) so the "Review 已保存 →"
// marker line is never truncated away before we can parse it.
const RUN_MAX_OUTPUT = 4 << 20

const REVIEW_SAVED_RE = /Review 已保存 →\s*(\S+)/

// Copy a generated review to <studio>/sandbox/weekly-investment-review so the
// web UI can preview it via a relative path (which is within fsRoots). Resolved
// against the resolve-studio root (5 levels up from this file), overridable via
// RESOLVE_STUDIO_DIR.
const STUDIO_ROOT = process.env.RESOLVE_STUDIO_DIR ?? resolve(HERE, '../../../../..')
async function copyReviewToSandbox(srcPath: string, content: string): Promise<string> {
  const destDir = join(STUDIO_ROOT, 'sandbox', 'weekly-investment-review')
  await mkdir(destDir, { recursive: true })
  // 产物路径形如 output/<model>/weekly_review_<date>.md —— 把模型目录名嵌入副本
  // 文件名，避免不同模型目录（free / deepseek）同一天的报告互相覆盖。
  const modelDir = basename(dirname(srcPath))
  const destName = `${modelDir}__${basename(srcPath)}`
  await writeFile(join(destDir, destName), content, 'utf8')
  return `sandbox/weekly-investment-review/${destName}`
}

/**
 * Bridges the full autogen-pse PSE portfolio-review pipeline:
 *
 *   1. `prepare.py`        → regenerate output/portfolio_review_prompt.md
 *   2. `run.py`            → Planner/Specialist/Evaluator team (+ personal
 *                            knowledge-base retrieval) produces the review
 *   3. returns the saved review file content (the full report)
 *
 * This is the primary weekly-review tool: same data source as the (removed)
 * portfolio-summary, but multi-agent analysis with quality gates instead of a
 * single-pass summary.
 *
 * NOTE: real holdings + real model calls — local private use only.
 *
 * ── Model provider (explicit, not implicit) ──
 * autogen-pse's `run.py` reads `OPENAI_MODEL` / `OPENAI_BASE_URL` / `OPENAI_API_KEY`
 * from the environment (os.environ overrides its own `.env`). This tool USED to
 * just inherit `process.env`, which silently made it follow whatever the harness
 * `.env` happened to set (currently gpt-4o-mini) — a fragile, invisible choice.
 * Now the provider is explicit:
 *
 *   provider = config.provider ?? process.env.PSE_REVIEW_PROVIDER ?? 'free'
 *
 * - 'free'      → FREE, non-streaming. Uses the harness `.env` OpenAI-compatible
 *                 creds that are already in process.env; sets PSE_MODEL_STREAM=false
 *                 (matches autogen-pse's `make review-free`).
 * - 'deepseek'  → PAID (DeepSeek V4 Pro). Overrides model/base_url to deepseek and
 *                 DROPS OPENAI_API_KEY so run.py falls back to autogen-pse/.env's
 *                 deepseek key (cwd=AUTOGEN_PSE → pydantic env_file); sets
 *                 PSE_MODEL_STREAM=true (matches `make review-deepseek`).
 */

export interface PseReviewConfig {
  /** 'free' (default) or 'deepseek' (paid). Defaults to 'free'. */
  provider?: 'free' | 'deepseek'
}

function buildRunEnv(provider: 'free' | 'deepseek'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (provider === 'deepseek') {
    // Override to DeepSeek; drop the inherited key so run.py reads the
    // deepseek key from its own .env (env_file, since cwd=AUTOGEN_PSE).
    env.OPENAI_MODEL = 'deepseek-v4-flash'
    env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
    delete env.OPENAI_API_KEY
    env.PSE_MODEL_STREAM = 'true'
  } else {
    // free: harness .env already carries the correct OPENAI_* creds;
    // just pin non-streaming for stability (free tier streaming is flaky).
    env.PSE_MODEL_STREAM = 'false'
  }
  return env
}

const registerPseReview = (ctx: Context, config: PseReviewConfig = {}) => {
  // Resolve provider: yml config > env override > default (free).
  const rawProvider = config.provider ?? (process.env.PSE_REVIEW_PROVIDER as string | undefined)
  const provider: 'free' | 'deepseek' = rawProvider === 'deepseek' ? 'deepseek' : 'free'
  const runEnv = buildRunEnv(provider)
  ctx.logger('pse-review').info('provider=%s (paid=%s)', provider, provider === 'deepseek')

  ctx.tools.register({
    name: 'pse-review',
    description:
      'Run the full PSE portfolio review (autogen-pse pipeline): regenerates the ' +
      'portfolio summary and runs a Planner/Specialist/Evaluator agent team with ' +
      'personal knowledge-base retrieval to produce an in-depth weekly review. ' +
      'Takes 2-6 minutes and calls the configured LLM. Returns the complete review ' +
      'report (Markdown). Use for a serious, quality-gated weekly review. ' +
      `[model provider: ${provider}${provider === 'deepseek' ? ' (PAID)' : ' (free)'}].` +
      (provider === 'deepseek'
        ? ' This deployment uses the PAID deepseek provider, so every run requires human approval.'
        : ''),
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    // Provider is fixed at registration (config/env), not a per-call argument —
    // gate the whole tool when it is the paid deepseek provider.
    needsApproval: provider === 'deepseek',
    async execute(): Promise<string> {
      let autogenPse: string
      try {
        autogenPse = resolvePseDir('autogen')
      } catch (e) {
        return `error: pse-review — ${(e as Error).message}`
      }
      // 1) regenerate the prompt file (this also refreshes analysis-lens returns)
      const prep = await runPseTask({
        tool: 'pse-review',
        framework: 'autogen',
        task: 'portfolio-review',
        runFile: PREPARE,
        taskDir: autogenPse,
        args: [],
        env: runEnv,
        timeoutMs: PREPARE_TIMEOUT_MS,
        logger: (msg, ...a) => ctx.logger('pse-review').info(msg, ...a),
      })
      if (!prep.ok) {
        return `error: pse-review prepare step failed — ${prep.error.replace(/^error:\s*/, '')}`
      }
      ctx.logger('pse-review').info('prepare ok: %s', prep.stdout.trim().slice(0, 160))

      // 2) run the PSE team
      const run = await runPseTask({
        tool: 'pse-review',
        framework: 'autogen',
        task: 'portfolio-review',
        runFile: RUN,
        taskDir: autogenPse,
        args: [],
        env: runEnv,
        timeoutMs: RUN_TIMEOUT_MS,
        maxOutput: RUN_MAX_OUTPUT,
        logger: (msg, ...a) => ctx.logger('pse-review').info(msg, ...a),
      })
      if (!run.ok) {
        return `error: pse-review run step failed — ${run.error.replace(/^error:\s*/, '')}`
      }

      // 3) return the saved review file (full report) if present
      const m = REVIEW_SAVED_RE.exec(run.stdout)
      if (m?.[1]) {
        try {
          const review = await readFile(m[1], { encoding: 'utf8' })
          const rel = await copyReviewToSandbox(m[1], review)
          const note = `> PSE review 已保存（预览副本）：${rel}\n` + `> 原始路径：${m[1]}\n\n`
          return truncate(note + review, MAX_OUTPUT)
        } catch {
          // fall through to stdout
        }
      }
      return truncate(run.stdout || '(no output)', MAX_OUTPUT)
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolPseReview = definePlugin(registerPseReview, 'tool-pse-review', ['tools'])
