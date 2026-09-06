import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'

const execFileAsync = promisify(execFile)

/** dev-stats project root, from DEV_STATS_DIR (env-only). Null if unset. */
function devStatsDir(): string | null {
  return process.env.DEV_STATS_DIR ?? null
}

// 掘金/思否/Actions 都是逐仓库拉取的远端查询，仓库多时接近分钟级。
const RUN_TIMEOUT_MS = 300_000
const RUN_MAX_BUFFER = 16 << 20

/** 可暴露给 Agent 的 make 目标：全部只读查询或本地导出，不碰依赖与代码。 */
const TARGETS = ['report', 'juejin', 'segmentfault', 'ci', 'actions', 'csv', 'run'] as const
type Target = (typeof TARGETS)[number]

const TARGET_DESCRIPTIONS: Record<Target, string> = {
  report:
    '汇总掘金 + 思否文章数据，按母文章合并对比（默认 --sort daily 日均阅读）。' +
    '思否默认禁用或拉取失败时自动降级为仅掘金并附说明，不会整体报错。',
  juejin: '掘金文章阅读/点赞/评论（默认 --sort daily，可 ARGS 覆盖）。',
  segmentfault:
    '思否文章阅读/访客/点赞/收藏/评论（默认 --sort daily，可 ARGS 覆盖）。' +
    '思否抓取默认禁用（需 .env 设置 SEGMENTFAULT_ENABLED=true）；未启用时只返回提示、无数据，属正常现象，不要重试。',
  ci:
    'CI 巡检（推荐）：只输出「CI 巡检小结」——失败仓库 + workflow + 失败步骤 + 报错注解，跳过流量采集与仓库大表，约 50 秒。' +
    '问「哪些仓库 CI 挂了」时优先用这个。',
  actions:
    '巡检各仓库 CI 状态并附带完整仓库统计大表（--actions，默认排除 fork 与老仓噪音）。' +
    '注意：管道输出里表格的 CI 列会被挤没，只要「哪些挂了」的结论请改用 target=ci。',
  csv: '导出仓库统计到 output/stats.csv（按 14 天 clone 数降序，默认脱敏）。',
  run: '透传运行 dev-stats CLI（等价 make run ARGS=...），用于上面的目标覆盖不到的参数组合。',
}

const registerDevStats = (ctx: Context) => {
  const targetHelp = TARGETS.map((t) => `${t}：${TARGET_DESCRIPTIONS[t]}`).join('\n')
  ctx.tools.register({
    name: 'dev-stats',
    description:
      '开发者数据统计（dev-stats 项目）：查掘金/思否文章阅读数据、汇总双平台传播对比、' +
      '巡检各仓库 GitHub Actions CI 状态、导出仓库 clone 统计 CSV。' +
      '通过 make 目标执行，全部为只读查询或本地文件导出，不改依赖、不改代码。' +
      'dev-stats 目录在沙箱外，shell 无法直接访问；所有查询请走本工具，失败时先读返回的错误信息再决定动作，不要用 shell 重试。' +
      '输出末尾自带「文章链接」清单（每篇的原文 URL）；回答涉及具体文章时，请把标题渲染成 Markdown 链接指向该 URL，方便直接跳转查看。\n' +
      targetHelp,
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要执行的 make 目标。',
          enum: [...TARGETS],
          default: 'report',
        },
        args: {
          type: 'string',
          description:
            '透传给 make 的 ARGS 变量（如 "--sort views --limit 5" 或 "--limit 20"）。' +
            '各目标的默认参数已内置，仅在需要换排序/条数/过滤时才传。',
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const dir = devStatsDir()
      if (!dir) {
        return 'error: DEV_STATS_DIR is not set. Export it to the absolute path of the dev-stats project root (e.g. in .env).'
      }
      const target = ((args.target as string | undefined)?.trim() || 'report') as Target
      if (!TARGETS.includes(target)) {
        return `error: 未知目标 "${target}"，可用目标：${TARGETS.join(' / ')}。`
      }
      const rawArgs = (args.args as string | undefined)?.trim()
      const makeArgs: string[] = [target]
      if (rawArgs) makeArgs.push(`ARGS=${rawArgs}`)

      try {
        const res = await execFileAsync('make', makeArgs, {
          cwd: dir,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: RUN_MAX_BUFFER,
          env: process.env,
        })
        const out = `${res.stdout}\n${res.stderr}`.trim()
        return [
          `dev-stats make ${target}${rawArgs ? ` ARGS=${rawArgs}` : ''}（${dir}）：`,
          '',
          out || '（无输出）',
        ].join('\n')
      } catch (err) {
        const e = err as { message?: string; stderr?: string; stdout?: string }
        const detail = e.stderr ?? e.stdout ?? e.message ?? String(err)
        return `error: dev-stats make ${target} 失败 — ${detail.slice(0, 800)}`
      }
    },
  })
}

export const toolDevStats = definePlugin(registerDevStats, 'tool-dev-stats', ['tools'])
