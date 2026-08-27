import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const execFileAsync = promisify(execFile)

// Locate the sibling autogen-pse project from this file's location
// (…/resolve-studio/packages/core/src/plugins/tools),
// independent of the process working directory. Override with AUTOGEN_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const AUTOGEN_PSE =
  process.env.AUTOGEN_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')
const PREPARE = join('tasks', 'portfolio-review', 'prepare.py')

// The prepare script internally re-runs `make calculate` in analysis-lens (up to
// 120s) plus its own market/gold/property sections. Give the bridge headroom.
const RUN_TIMEOUT_MS = 150_000
const MAX_OUTPUT = 32 * 1024

/**
 * Bridges the local (private) portfolio-review pipeline:
 *
 *   uv run python tasks/portfolio-review/prepare.py --print
 *
 * in the autogen-pse project, which reads real holdings from the money-csv
 * snapshots and emits a structured Markdown summary (overview / market /
 * returns / risk / efficiency…). The agent then follows a skill to turn that
 * summary into a weekly review report.
 *
 * NOTE: this tool feeds on REAL portfolio data — it is meant for local,
 * private use only. Do not publish it, its output, or any captured summary.
 */
const registerPortfolioSummary = (ctx: Context) => {
  ctx.tools.register({
    name: 'portfolio-summary',
    description:
      'Generate the local investment portfolio summary (Markdown): total assets, ' +
      'returns (realized/unrealized/yields), allocation, gold & property snapshots, ' +
      'market indices, detected issues and efficiency. Uses the real private holdings ' +
      'snapshot from autogen-pse. Returns a structured Markdown document; use a ' +
      'weekly-review skill to turn it into a report.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(): Promise<string> {
      try {
        const { stdout, stderr } = await execFileAsync(
          'uv',
          ['run', 'python', PREPARE, '--print'],
          {
            cwd: AUTOGEN_PSE,
            timeout: RUN_TIMEOUT_MS,
            maxBuffer: 1 << 20,
            env: process.env,
          },
        )
        if (!stdout.trim()) {
          return `error: portfolio-summary produced empty output${stderr ? ` — stderr: ${truncate(stderr, 500)}` : ''}`
        }
        return truncate(stdout, MAX_OUTPUT)
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string }
        const detail = e.stderr ?? e.message ?? String(err)
        return `error: portfolio-summary failed — ${truncate(detail, 600)}`
      }
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolPortfolioSummary = definePlugin(
  registerPortfolioSummary,
  'tool-portfolio-summary',
  ['tools'],
)
