import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const execFileAsync = promisify(execFile)

// …/resolve-studio/packages/core/src/plugins/tools →
// 8 levels up = ***REMOVED***. Override with AUTOGEN_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const AUTOGEN_PSE =
  process.env.AUTOGEN_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')
const PREPARE = join('tasks', 'portfolio-review', 'prepare.py')
const RUN = join('tasks', 'portfolio-review', 'run.py')

// prepare re-runs analysis-lens `make calculate` (≤120s); run.py runs the full
// PSE team (planner/specialist/evaluator + knowledge retrieval, streaming) —
// give each step generous timeouts.
const PREPARE_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 480_000
const MAX_OUTPUT = 48 * 1024

const REVIEW_SAVED_RE = /Review 已保存 →\s*(\S+)/

/**
 * Bridges the full autogen-pse PSE portfolio-review pipeline:
 *
 *   1. `prepare.py`        → regenerate output/portfolio_review_prompt.md
 *   2. `run.py`            → Planner/Specialist/Evaluator team (+ personal
 *                            knowledge-base retrieval) produces the review
 *   3. returns the saved review file content (the full report)
 *
 * This is the "heavy" counterpart to portfolio-summary: same data source, but
 * multi-agent analysis with quality gates instead of a single-pass summary.
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
      'report (Markdown). Use for a serious, quality-gated review instead of the ' +
      'quick portfolio-summary. ' +
      `[model provider: ${provider}${provider === 'deepseek' ? ' (PAID)' : ' (free)'}].`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(): Promise<string> {
      // 1) regenerate the prompt file (this also refreshes analysis-lens returns)
      try {
        const prep = await execFileAsync('uv', ['run', 'python', PREPARE], {
          cwd: AUTOGEN_PSE,
          timeout: PREPARE_TIMEOUT_MS,
          maxBuffer: 1 << 20,
          env: runEnv,
        })
        ctx.logger('pse-review').info('prepare ok: %s', (prep.stdout ?? '').trim().slice(0, 160))
      } catch (err) {
        const e = err as { message?: string; stderr?: string }
        return `error: pse-review prepare step failed — ${truncate(e.stderr ?? e.message ?? String(err), 600)}`
      }

      // 2) run the PSE team
      let stdout = ''
      try {
        const run = await execFileAsync('uv', ['run', 'python', RUN], {
          cwd: AUTOGEN_PSE,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: 4 << 20,
          env: runEnv,
        })
        stdout = run.stdout ?? ''
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string }
        const tail = (e.stdout ?? e.stderr ?? e.message ?? String(err)).slice(-800)
        return `error: pse-review run step failed — ${truncate(tail, 800)}`
      }

      // 3) return the saved review file (full report) if present
      const m = REVIEW_SAVED_RE.exec(stdout)
      if (m?.[1]) {
        try {
          const review = await readFile(m[1], { encoding: 'utf8' })
          const note = `> PSE review saved to ${m[1]}\n\n`
          return truncate(note + review, MAX_OUTPUT)
        } catch {
          // fall through to stdout
        }
      }
      return truncate(stdout || '(no output)', MAX_OUTPUT)
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolPseReview = definePlugin(registerPseReview, 'tool-pse-review', ['tools'])
