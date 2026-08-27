import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

const execFileAsync = promisify(execFile)

// …/resolve-studio/packages/core/src/plugins/tools →
// 8 levels up = ***REMOVED***. Override with CREWAI_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const CREWAI_PSE =
  process.env.CREWAI_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')

const TASK_TIMEOUT_MS = 60_000
const MAX_OUTPUT = 64 * 1024

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

const registerCrewAiDiscover = (ctx: Context) => {
  ctx.tools.register({
    name: 'article-discover',
    description:
      '扫描大项目（***REMOVED***）下所有有 github remote 的子项目，对比已有 projects.json，输出建议新增的项目列表（含 desc/highlights/source_dir 自动生成）。用于发现可写技术文章的新项目。默认只输出建议不写入；传 add=true 直接写入 projects.json。',
    parameters: {
      type: 'object',
      properties: {
        add: {
          type: 'boolean',
          description: 'If true, write discovered new projects into projects.json directly. Default false (dry-run).',
          default: false,
        },
      },
      required: [],
    },
    async execute(
      args: { add?: boolean },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { add = false } = args
      const onProgress = execCtx?.onProgress

      const flags = add ? ['--add'] : []
      ctx.logger('article-discover').info('running make discover (add=%s, cwd=%s)', add, CREWAI_PSE)

      try {
        const { stdout, stderr } = await execFileAsync(
          'make',
          ['discover', ...flags],
          {
            cwd: CREWAI_PSE,
            timeout: TASK_TIMEOUT_MS,
            maxBuffer: 8 << 20,
          },
        )
        const combined = (stdout || '') + (stderr ? '\n--- stderr ---\n' + stderr : '')
        onProgress?.(combined)
        const header = add ? '> 已写入 projects.json\n\n' : '> 扫描结果（dry-run，未写入）\n\n'
        return header + truncate(combined, MAX_OUTPUT)
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string; code?: number }
        const tail = (e.stdout || '') + (e.stderr ? '\n--- stderr ---\n' + e.stderr : '') || e.message || String(err)
        return `error: article-discover failed (exit ${e.code ?? 'unknown'}) — ${truncate(tail, 4000)}`
      }
    },
  } satisfies Tool)

  ctx.logger('crewai-discover').info('registered article-discover tool')
}

export const toolCrewAiDiscover = definePlugin(registerCrewAiDiscover, 'tool-crewai-discover', ['tools'])
