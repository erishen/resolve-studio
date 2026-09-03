import { join } from 'node:path'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { resolveTaskDir, resolvePseDirOrNull, runPseScript } from './util-pse.js'
import type { Tool } from '../../types.js'

// llamaindex-pse hot-news task owns the multi-source news fetcher
// (fetch_news.py) that feeds the RAG grounding corpus. This is the first step
// of the hot-news publishing pipeline: refresh facts, then pick → generate →
// check. It only writes to the task's news/ snapshot dir.
const hotNewsDir = () => resolveTaskDir('llamaindex', 'hot-news')
const newsDir = () => join(hotNewsDir(), 'news')
// Display-only default for the schema; never throws when PSE_DIR is unset so
// the tool can still register/be listed in tests and CI.
const newsDirDesc = () =>
  resolvePseDirOrNull('llamaindex')
    ? newsDir()
    : join('.data', 'pse', 'llamaindex', 'hot-news', 'news')

const SOURCES = ['weibo', 'kr36', 'sspai', 'qbitai', 'infoq'] as const

const registerHotNewsFetch = (ctx: Context, _config: Record<string, never> = {}) => {
  ctx.tools.register({
    name: 'hot-news-fetch',
    description:
      '抓取多平台热点新闻（微博热搜 weibo / 36氪 kr36 / 少数派 sspai / 量子位 qbitai / InfoQ infoq）' +
      '落盘为 Markdown，作为 hot-news 生成管线的事实 grounding 源（RAG 语料）。' +
      '这是热点营销流水线的第一步：先用本工具刷新素材，再 hot-news-topics 选话题 → hot-news 生成 → hot-news-check 校验。' +
      '只写 tasks/hot-news/news/ 快照目录，不改任何其他文件；无需审批。',
    parameters: {
      type: 'object',
      properties: {
        sources: {
          type: 'string',
          description:
            `逗号分隔的源，默认全部；可选：${SOURCES.join(', ')}。` +
            'tech_ai 品类建议优先 qbitai,infoq（AI 命中率远高于微博热搜）。',
          default: SOURCES.join(','),
        },
        limit: {
          type: 'integer',
          description: '每源保留条数（默认 30）。',
          default: 30,
          minimum: 1,
          maximum: 200,
        },
        max_age_days: {
          type: 'integer',
          description: '仅保留 N 天内的热点（0=不过滤，默认 2）；微博热榜无发布时间不应用。',
          default: 2,
          minimum: 0,
        },
        clean: {
          type: 'boolean',
          description: '重写前清空 out 目录（干净快照，仅在抓到数据时才清空，避免全失败误删）。',
          default: false,
        },
        use_proxy: {
          type: 'boolean',
          description: '走系统代理（默认直连，避开代理对公开域名的 TLS 干扰）。',
          default: false,
        },
        out: {
          type: 'string',
          description: `落盘目录（默认 ${newsDirDesc()}）。`,
        },
      },
      required: [],
    },
    async execute(args, execCtx): Promise<string> {
      const sources = (args.sources as string | undefined)?.trim()
      const limit = args.limit as number | undefined
      const maxAgeDays = args.max_age_days as number | undefined
      const clean = !!args.clean
      const useProxy = !!args.use_proxy

      // Validate cheap user input before touching the (env-driven) PSE dir so a
      // bad source fails fast with an actionable message instead of a missing
      // env error.
      if (sources) {
        for (const s of sources.split(',')) {
          const cs = s.trim()
          if (cs && !(SOURCES as readonly string[]).includes(cs)) {
            return `error: hot-news-fetch 未知源「${cs}」；可用: ${SOURCES.join(', ')}`
          }
        }
      }

      const out = (args.out as string | undefined)?.trim() || newsDir()

      const cmdArgs = [`--out=${out}`]
      if (sources) cmdArgs.push(`--sources=${sources}`)
      if (limit != null) cmdArgs.push(`--limit=${limit}`)
      if (maxAgeDays != null) cmdArgs.push(`--max-age-days=${maxAgeDays}`)
      if (clean) cmdArgs.push('--clean')
      if (useProxy) cmdArgs.push('--use-proxy')

      const res = await runPseScript({
        tool: 'hot-news-fetch',
        script: join(hotNewsDir(), 'fetch_news.py'),
        cwd: hotNewsDir(),
        args: cmdArgs,
        onProgress: execCtx?.onProgress,
        logger: (msg, ...a) => ctx.logger('hot-news-fetch').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const body = res.stdout.replace(/\n{3,}/g, '\n\n').trim()
      return [
        `> hot-news-fetch 完成 → ${out}${sources ? `（源：${sources}）` : '（全部源）'}`,
        '',
        body.length > 3000 ? body.slice(-3000) : body,
        '',
        '> 下一步：用 hot-news-topics 列候选话题，再让 hot-news 按平台生成合规文案。',
      ].join('\n')
    },
  } satisfies Tool)
}

export const toolHotNewsFetch = definePlugin(registerHotNewsFetch, 'tool-hot-news-fetch', ['tools'])
