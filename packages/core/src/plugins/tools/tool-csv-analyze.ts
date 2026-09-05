import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

const execFileAsync = promisify(execFile)

/**
 * langgraph-csv-analyst project root, resolved from LANGGRAPH_CSV_ANALYST_DIR
 * (env-only). Returns null when the variable is unset, so callers can fall
 * back to a caller-supplied file or surface an actionable error.
 */
function csvAnalystDir(): string | null {
  return process.env.LANGGRAPH_CSV_ANALYST_DIR ?? null
}

const STEP_TIMEOUT_MS = 300_000
const STEP_MAX_BUFFER = 16 << 20

const registerCsvAnalyze = (ctx: Context) => {
  ctx.tools.register({
    name: 'csv-analyze',
    description:
      'CSV 数据多智能体分析：对给定 CSV 文件用 LangGraph 流水线做数据剖析/趋势/异常检测，' +
      '产出 HTML 报告（langgraph-csv-analyst）。' +
      '用于"把这个 CSV 分析一下给我一份报告"之类的请求。只读输入文件，不改动数据。',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            `CSV 文件路径（绝对路径或工作区内相对路径）。留空则用内置样例样本 ` +
            `（data/sample_sales.csv，用于"帮我把这个 CSV 分析一下"快速演示）。`,
        },
        output: {
          type: 'string',
          description: 'HTML 报告输出路径（默认 <csv 同名>_report.html，落在 csv 所在目录）。',
        },
        profile: {
          type: 'boolean',
          description: '只快速剖析（不产图/异常检测），更快。',
          default: false,
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args, execCtx: ToolExecutionContext | undefined): Promise<string> {
      const dir = csvAnalystDir()
      const sampleCsv = dir ? resolve(dir, 'data/sample_sales.csv') : null
      const file = (args.file as string | undefined)?.trim() || sampleCsv
      if (!file) {
        return 'error: csv-analyze 需要 file 参数，或设置 LANGGRAPH_CSV_ANALYST_DIR 以使用内置样例 data/sample_sales.csv。'
      }
      const usingSample = file === sampleCsv

      const profile = !!args.profile
      const output = (args.output as string | undefined)?.trim()

      const logs: string[] = [
        `分析目录：${dir ?? '(未设置 LANGGRAPH_CSV_ANALYST_DIR)'}`,
        `输入：${file}`,
        usingSample ? '> 未指定 CSV，使用内置样例 data/sample_sales.csv。' : '',
        '',
      ]
      const cmdArgs = profile
        ? ['run', 'python', '-m', 'langgraph_csv_analyst.cli', 'profile', file]
        : [
            'run',
            'python',
            '-m',
            'langgraph_csv_analyst.cli',
            'analyze',
            file,
            ...(output ? ['--output', output] : []),
          ]

      try {
        const { stdout, stderr } = await execFileAsync('uv', cmdArgs, {
          cwd: dir ?? undefined,
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: STEP_MAX_BUFFER,
          env: process.env,
        })
        const combinedOutput = `${stdout}\n${stderr}`
        const notable = combinedOutput
          .split('\n')
          .filter((l) => /[⚠❌]|报告|report|written|保存|error|warn|异常|已输出/i.test(l))
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 30)
          .join('\n')
        if (notable) logs.push(notable)
        // Detected a partial-failure: the pipeline degraded (e.g. Trend / Anomaly
        // sub-agents 503) but still produced a report. Surface this prominently so
        // the calling agent / PSE Evaluator knows the analysis is INCOMPLETE and
        // should be retried rather than treated as a clean success.
        const reportDefault =
          output ?? resolve(dirname(file), `${basename(file).replace(/\.csv$/i, '')}_report.html`)
        const partial =
          /\berrors?\b/i.test(combinedOutput) ||
          /503|timeout|timed out|unavailable/i.test(combinedOutput)
        if (partial) {
          try {
            await access(reportDefault)
          } catch {
            // No report landed → hard failure, not partial.
            return `error: csv-analyze 报告未生成 — ${truncate(combinedOutput.slice(-600), 600)}`
          }
          logs.push(
            '',
            '⚠️ 分析部分失败：趋势/异常检测子智能体报错（如 503），报告缺少趋势(Trend)与异常(Anomaly)两个完整模块，' +
              '不可当作完整结果。应重试（可稍等后再次调用 csv-analyze 以获得完整趋势与异常分析），' +
              '不要据此判定任务完成。',
          )
        }
        logs.push('', `> 分析报告已生成 → ${reportDefault}`)

        // Background jobs have a per-run workspace where artifacts must land so
        // the report becomes a browsable job artifact (sandbox would block the
        // model from copying it via fs/shell). Mirror the report there and report
        // the workspace path so the model just reads/writes within the workspace.
        const workspace = execCtx?.workspace
        if (workspace && reportDefault) {
          try {
            await mkdir(workspace, { recursive: true })
            const inWs = join(workspace, basename(reportDefault))
            await copyFile(reportDefault, inWs)
            logs.push(`> 已复制到工作区 → ${inWs}`)
          } catch (e) {
            const err = e as { message?: string }
            logs.push(`> 复制报告到工作区失败（${err?.message ?? String(e)}），原路径仍可用。`)
          }
        }

        const base = await ensurePreviewServer()
        const preview = base ? toPreviewUrl(reportDefault) : null
        if (preview) {
          logs.push(`> 在线预览（可用 browser-open 打开）→ ${preview}`)
        }
        logs.push(
          usingSample
            ? '> 这是内置样例的分析结果；需要分析你自己的数据请再次调用并传 file 参数。'
            : '> 提示：报告为 HTML，可在浏览器打开；需要落库请让用户指定 output 路径。',
        )
        return logs.join('\n')
      } catch (err) {
        const e = err as { message?: string; stderr?: string; stdout?: string }
        return `error: csv-analyze 失败 — ${truncate(e.stderr ?? e.stdout ?? e.message ?? String(err), 800)}`
      }
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

// --------------------------------------------------------------------------- //
// Local static preview — browser-open only accepts http(s) URLs, so a bare
// file path is not viewable by the agent. We run a tiny 127.0.0.1 static file
// server rooted at the langgraph-csv-analyst project so the generated HTML
// report (and its sibling files) get an http:// URL the agent can open.
// A single module-level server is reused across calls; it lives for the whole
// process lifetime, which is exactly what we want for a long-lived harness.
// --------------------------------------------------------------------------- //

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

const HTML_SAFE_EXT = /\.(html?|json|png|jpe?g|svg|css|js|csv)$/i

let previewServer: Server | null = null
let previewBase: string | null = null

async function ensurePreviewServer(): Promise<string | null> {
  if (previewServer && previewBase) return previewBase
  const d = csvAnalystDir()
  if (!d) return null
  const root = resolve(d)
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405).end('method not allowed')
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (!HTML_SAFE_EXT.test(url.pathname) || url.pathname.includes('..')) {
          res.writeHead(403).end('forbidden')
          return
        }
        const file = join(root, url.pathname)
        const buf = await readFile(file)
        const ext = basename(file).replace(/.*\./, '.').toLowerCase()
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' })
        res.end(buf)
      } catch {
        res.writeHead(404).end('not found')
      }
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  if (!port) return null
  previewServer = server
  previewBase = `http://127.0.0.1:${port}`
  return previewBase
}

/** Map an absolute report path to its http:// preview URL, or null if unsupported. */
function toPreviewUrl(reportPath: string): string | null {
  if (!previewBase) return null
  const d = csvAnalystDir()
  if (!d) return null
  const root = resolve(d)
  const rel = relative(root, resolve(reportPath))
  if (rel.startsWith('..') || rel.includes('..') || !HTML_SAFE_EXT.test(rel)) return null
  return `${previewBase}/${rel.split('\\').join('/')}`
}

export const toolCsvAnalyze = definePlugin(registerCsvAnalyze, 'tool-csv-analyze', ['tools'])
