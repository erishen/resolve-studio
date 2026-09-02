import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const execFileAsync = promisify(execFile)

/** market-analyzer project root, from STOCK_ANALYZER_DIR (env-only). Null if unset. */
function stockAnalyzerDir(): string | null {
  return process.env.STOCK_ANALYZER_DIR ?? null
}

const STEP_TIMEOUT_MS = 300_000
const STEP_MAX_BUFFER = 16 << 20

// Human-nominated stock codes are usually a personal matrix; keep the tool
// read-only over the local market snapshot and never mutate holdings.
const registerStockScan = (ctx: Context) => {
  ctx.tools.register({
    name: 'stock-scan',
    description:
      'A股全市场技术信号扫描：在 market-analyzer 项目里运行 scan 子命令，' +
      '扫描全市场 K 线，输出趋势/买入/卖出信号 JSON。' +
      '用于投资研究的前置信号发现（如"看看今天全市场有哪些值得关注的信号"）。' +
      '只读本地行情快照，不修改任何持仓或数据。',
    parameters: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'JSON 报告输出路径（默认 output/reports/scan_result.json）。',
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const stockAnalyzer = stockAnalyzerDir()
      if (!stockAnalyzer) {
        return 'error: STOCK_ANALYZER_DIR is not set. Export it to the absolute path of the market-analyzer project root (e.g. in .env).'
      }
      const output =
        (args.output as string | undefined)?.trim() || 'output/reports/scan_result.json'

      const logs: string[] = [`扫描目录：${stockAnalyzer}`, '']
      let stdout = ''
      let stderr = ''
      try {
        const res = await execFileAsync(
          'uv',
          ['run', 'python', '-m', 'src.main', 'scan', '--output', output],
          {
            cwd: stockAnalyzer,
            timeout: STEP_TIMEOUT_MS,
            maxBuffer: STEP_MAX_BUFFER,
            env: process.env,
          },
        )
        stdout = res.stdout
        stderr = res.stderr
        const notable = `${stdout}\n${stderr}`
          .split('\n')
          .filter((l) => /[⚠❌]|信号|买入|卖出|趋势|error|warn|异常|失败/i.test(l))
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(0, 30)
          .join('\n')
        if (notable) logs.push(notable)
      } catch (err) {
        const e = err as { message?: string; stderr?: string; stdout?: string }
        return `error: stock-scan 全市场信号扫描失败 — ${truncate(e.stderr ?? e.stdout ?? e.message ?? String(err), 800)}`
      }

      // The scan writes an up-to-~4MB JSON report too large for read-file
      // (64KiB cap). Embed a compact top-N table + signal-type distribution
      // directly so the agent can list signals without a follow-up read.
      logs.push(...renderSummary(join(stockAnalyzer, output)))
      logs.push('', `> 信号报告已写 → ${join(stockAnalyzer, output)}`)
      logs.push('> 下一步：对感兴趣的信号可用 stock-backtest 回测，或 stock-score 看排名。')
      return logs.join('\n')
    },
  } satisfies Tool)
}

interface ScanSignal {
  code?: string
  name?: string
  signal_type?: string
  strength?: string
  price?: number
  change_percent?: number
  score?: number
}

/** Parse the scan report and render an agent-friendly Top-N + distribution summary. */
function renderSummary(path: string): string[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return ['', '> （未能读取信号报告 JSON，仅以上述 CLI 输出为准）']
  }
  let data: { top_signals?: unknown; summary?: Record<string, unknown>; signals_found?: number }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    return ['', '> （信号报告 JSON 解析失败，仅以上述 CLI 输出为准）']
  }

  const lines: string[] = []
  const top = Array.isArray(data.top_signals) ? (data.top_signals as ScanSignal[]) : []
  if (top.length) {
    lines.push(
      '',
      '**Top 信号（按得分）：**',
      '',
      '| 代码 | 名称 | 类型 | 强度 | 得分 | 价格 | 涨跌幅 |',
    )
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const s of top.slice(0, 20)) {
      lines.push(
        `| ${s.code ?? '?'} | ${s.name ?? '?'} | ${s.signal_type ?? '?'} | ${s.strength ?? ''} | ` +
          `${s.score ?? ''} | ${s.price ?? ''} | ${s.change_percent != null ? `${s.change_percent}%` : ''} |`,
      )
    }
  }

  const summary = data.summary as Record<string, unknown> | undefined
  if (summary && typeof summary === 'object' && Object.keys(summary).length) {
    lines.push('', '**信号类型分布：**')
    for (const [type, count] of Object.entries(summary)) lines.push(`- ${type}: ${count}`)
  }

  if (typeof data.signals_found === 'number')
    lines.push('', `> 共 ${data.signals_found.toLocaleString()} 个信号`)
  return lines
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolStockScan = definePlugin(registerStockScan, 'tool-stock-scan', ['tools'])
