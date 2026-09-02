import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const execFileAsync = promisify(execFile)

/** analysis-lens project root, from ASSET_LENS_DIR (env-only). Null if unset. */
function assetLensDir(): string | null {
  return process.env.ASSET_LENS_DIR ?? null
}

// Each `make` step can take a while on a cold cache; give each generous headroom.
const STEP_TIMEOUT_MS = 300_000
const STEP_MAX_BUFFER = 16 << 20

// Annualized return beyond this (%) is almost certainly an artifact of
// annualizing a short-horizon windfall (e.g. +201% in 10 days → 1e19%),
// not a real, sustainable rate — flag it as an anomaly.
const ANNUAL_RETURN_CAP = 10000

/**
 * Investment pre-flight data check.
 *
 * Runs `make calculate && make analyze && make compare` inside the analysis-lens
 * project to refresh the local snapshot, then scans the freshly generated
 * snapshot JSON for numeric anomalies (absurd annualized returns, broken
 * overall return, etc.) and returns a plain-language体检结论.
 *
 * Intended as a front task before any investment review: catch stale / broken
 * data first, then do the analysis. Read-only w.r.t. the user's holdings —
 * it only runs the local pipeline and reads the generated snapshot.
 */
const registerPortfolioCheck = (ctx: Context) => {
  ctx.tools.register({
    name: 'portfolio-check',
    description:
      '投资前数据体检：在 analysis-lens 项目里依次执行 make calculate / make analyze / make compare，' +
      '刷新本地持仓快照并扫描异常（如年化收益率为天文数字、整体收益异常、产品级离群值等），' +
      '返回体检结论。用于生成投资复盘前的前置检查，确认数据无误后再做正式分析。只读本地数据，不修改持仓。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    needsApproval: false,
    async execute(): Promise<string> {
      const assetLens = assetLensDir()
      if (!assetLens) {
        return 'error: ASSET_LENS_DIR is not set. Export it to the absolute path of the asset-lens project root (e.g. in .env).'
      }
      const steps = ['calculate', 'analyze', 'compare']
      const logs: string[] = [`数据目录：${assetLens}`, '']

      for (const step of steps) {
        logs.push(`🔄 make ${step} ...`)
        try {
          const { stdout, stderr } = await execFileAsync('make', [step], {
            cwd: assetLens,
            timeout: STEP_TIMEOUT_MS,
            maxBuffer: STEP_MAX_BUFFER,
            env: process.env,
          })
          const notable = `${stdout}\n${stderr}`
            .split('\n')
            .filter((l) => /[⚠❌]|异常|错误|过期|失败|error|warn/i.test(l))
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 20)
            .join('\n')
          if (notable) logs.push(notable)
        } catch (err) {
          const e = err as { message?: string; stderr?: string; stdout?: string }
          return `error: portfolio-check 在 make ${step} 阶段失败 — ${truncate(e.stderr ?? e.stdout ?? e.message ?? String(err), 800)}`
        }
      }

      logs.push('', '## 体检结论')
      const findings = await scanAnomalies(assetLens)
      logs.push(findings)
      return logs.join('\n')
    },
  } satisfies Tool)
}

async function scanAnomalies(assetLensDir: string): Promise<string> {
  const outDir = join(assetLensDir, 'output')
  let files: string[]
  try {
    files = (await readdir(outDir))
      .filter((f) => f.startsWith('投资收益率分析_') && f.endsWith('.json'))
      .sort()
      .reverse()
  } catch {
    return '⚠️ 未找到 analysis-lens 生成的快照 JSON（output/投资收益率分析_*.json），请确认 make analyze 已成功执行。'
  }
  if (!files.length) {
    return '⚠️ 未找到 analysis-lens 生成的快照 JSON（output/投资收益率分析_*.json）。'
  }

  const latest = join(outDir, files[0])
  let data: any
  try {
    data = JSON.parse(await readFile(latest, 'utf8'))
  } catch {
    return `⚠️ 无法解析快照文件：${latest}`
  }

  const lines: string[] = [`快照文件：${files[0]}（生成于 ${data.generated_at ?? '未知'}）`, '']
  const ev = (data.comprehensive_evaluation ?? {}) as Record<string, unknown>
  const w = parseFloat(String(ev.weighted_annual_return ?? '').replace('%', ''))
  if (!Number.isNaN(w) && Math.abs(w) > ANNUAL_RETURN_CAP) {
    lines.push(
      `- ⚠️ 加权年化收益率异常：${ev.weighted_annual_return}（合理上限约 ${ANNUAL_RETURN_CAP}%，疑似短周期暴利被年化，已失真）`,
    )
  } else {
    lines.push(`- 加权年化收益率：${ev.weighted_annual_return ?? 'N/A'}`)
  }
  lines.push(`- 整体收益率：${ev.overall_return_rate ?? 'N/A'}`)
  lines.push(`- 当前总资产：${ev.total_current_amount ?? 'N/A'}`)

  const prods: any[] = Array.isArray(data.products) ? data.products : []
  const outliers = prods
    .map((p) => ({
      name: p['名称'] ?? p.name ?? '?',
      ar: parseFloat(String(p['年化收益率(%)'] ?? p.annual_return ?? '').replace('%', '')),
    }))
    .filter((p) => !Number.isNaN(p.ar) && Math.abs(p.ar) > ANNUAL_RETURN_CAP)
  if (outliers.length) {
    lines.push(`- ⚠️ ${outliers.length} 只产品年化收益率异常（> ${ANNUAL_RETURN_CAP}%）：`)
    for (const o of outliers.slice(0, 10)) lines.push(`  - ${o.name}：${o.ar}%`)
  }

  const warns = data.risk_warnings
  if (Array.isArray(warns) && warns.length) {
    lines.push(`- 内置风险提示 ${warns.length} 条（详见快照 JSON 的 risk_warnings）`)
  }

  if (lines.length <= 3) lines.push('- ✅ 未发现明显数值异常')
  return lines.join('\n')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolPortfolioCheck = definePlugin(
  registerPortfolioCheck,
  'tool-portfolio-check',
  ['tools'],
)
