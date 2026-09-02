import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const execFileAsync = promisify(execFile)

// …/resolve-studio/packages/core/src/plugins/tools, 8 levels up = the workspace
// root hosting ***REMOVED***/. Override with PRODUCT_ANALYST_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const PRODUCT_ANALYST =
  process.env.PRODUCT_ANALYST_DIR ??
  resolve(HERE, '***REMOVED******REMOVED***/apps/crewai-product-analyst')

// 4 levels up = resolve-studio root, where the web preview serves sandbox/.
const STUDIO_ROOT = resolve(HERE, '../../../../..')

// Multi-agent research takes several minutes; allow up to 20 min so the crew
// can finish web research + strategy + writing without the tool timing out.
const STEP_TIMEOUT_MS = 1_200_000
const STEP_MAX_BUFFER = 16 << 20

/** Lowercase, slugify a product name into a safe filename segment. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'report'
  )
}

const registerProductAnalyze = (ctx: Context) => {
  ctx.tools.register({
    name: 'product-analyze',
    description:
      '产品/竞品分析：用 crewai-product-analyst 的三个智能体（调研/策略/撰写）' +
      '对给定产品名或线上产品做产品分析，产出 Markdown 报告并保存到 sandbox/。' +
      '用于"帮我研究一下 X 这个产品"之类的请求。只读，不改动任何本地数据。',
    parameters: {
      type: 'object',
      properties: {
        product: {
          type: 'string',
          description: '产品名或线上产品描述（如 "Notion AI"）。',
        },
        output: {
          type: 'string',
          description: 'Markdown 报告输出路径（可选；默认保存到 sandbox/<产品>-product-analysis.md）。',
        },
      },
      required: ['product'],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const product = (args.product as string | undefined)?.trim()
      if (!product) return 'error: product-analyze 需要 product 参数（产品名）。'

      // Always persist a report file so the run produces something on disk.
      const output = (args.output as string | undefined)?.trim() ?? join('sandbox', `${slug(product)}-product-analysis.md`)
      const outputAbs = resolve(STUDIO_ROOT, output)
      const outputAbsDir = dirname(outputAbs)

      // Strip ANSI escape codes so rich's colored panels don't garble the log.
      const ansi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
      const logs: string[] = [`分析目录：${PRODUCT_ANALYST}`, `产品：${product}`, '']
      const cmdArgs = [
        'run',
        'python',
        '-m',
        'crewai_product_analyst.main',
        'analyze',
        product,
        '--output',
        outputAbs,
      ]

      try {
        const { stdout, stderr } = await execFileAsync('uv', cmdArgs, {
          cwd: PRODUCT_ANALYST,
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: STEP_MAX_BUFFER,
          env: process.env,
        })
        const notable = `${stdout}\n${stderr}`
          .split('\n')
          .map(ansi)
          .filter((l) => /[⚠❌]|报告|report|written|保存|已输出|save|saved/i.test(l))
          .filter((l) => !/^[│╭╮┆]*$|cdn-cgi|cf-input|data-next-head|font-|\{display:|css/i.test(l))
          .map((l) => l.trim().replace(/^[│┆]+\s*/, ''))
          .filter(Boolean)
          .slice(0, 40)
          .join('\n')
        if (notable) logs.push(notable)
      } catch (err) {
        const e = err as Error & { stderr?: string; stdout?: string; killed?: boolean }
        const timedOut = e.killed || /timed? out|SIGKILL|ETIMEDOUT/i.test(e.message ?? '')
        const detail = ansi(e.stderr ?? e.stdout ?? e.message ?? String(err)).trim()
        return (
          'error: product-analyze 失败 — ' +
          (timedOut
            ? `分析超出 20 分钟仍未完成（已中止）。可重试，或让 agent 指定更聚焦的产品名。`
            : truncate(detail || '未知错误（无输出）', 800))
        )
      }

      logs.push('', `> 分析报告已保存 → ${outputAbs}`)
      logs.push('> 下一步：可在网页用 🖥️ 预览，或以 <file 内容> 形式返回。')
      return logs.join('\n')
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolProductAnalyze = definePlugin(registerProductAnalyze, 'tool-product-analyze', [
  'tools',
])
