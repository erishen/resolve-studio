import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { resolveTaskDir, runPseScript } from './util-pse.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// Playwright 发布器：publish/publish_<platform>.py 的 `publish` 子命令。
// 它在本机 Chrome 里把文章填进真实发布编辑器（自动配图/标题/正文/话题），
// 填好后**停在编辑器**由用户人工核对并自己点发布——绝不自动发布。
// 先要 login 一次（publish_<platform>.py login），登录态持久化在 publish/storage/。
const hotNewsDir = () => resolveTaskDir('llamaindex', 'hot-news')
const articlesDir = () => join(hotNewsDir(), 'articles')

// 填稿 + 插图 + 封面 + 浏览器自动化耗时较长，放宽到 15 分钟。
const RUN_TIMEOUT_MS = 900_000

/**
 * 找最新一篇已生成的热点稿。优先匹配目标平台（文件名含 _<platform>_），
 * 再退回任意 hot_news_*.md；文件名带 YYYYMMDD_HHMMSS 时间戳，字典序即时间序。
 */
async function latestArticle(platform: string): Promise<string | null> {
  for (const dir of [articlesDir(), hotNewsDir()]) {
    try {
      const files = (await readdir(dir)).filter(
        (f) => f.endsWith('.md') && f.startsWith('hot_news_'),
      )
      if (!files.length) continue
      const matched = files.filter((f) => f.includes(`_${platform}_`))
      const pool = (matched.length ? matched : files).sort().reverse()
      return join(dir, pool[0]!)
    } catch {
      // dir missing / unreadable → try the next candidate
    }
  }
  return null
}

const PLATFORMS = ['xiaohongshu', 'zhihu', 'toutiao'] as const
type Platform = (typeof PLATFORMS)[number]

const registerHotNewsPublish = (ctx: Context, _config: Record<string, never> = {}) => {
  ctx.tools.register({
    name: 'hot-news-publish',
    description:
      '把一篇热点稿用 Playwright 真浏览器填进发布编辑器（小红书 xiaohongshu / 知乎 zhihu / 今日头条 toutiao）：' +
      '自动生成品牌多图/封面、填标题/正文/话题，尽力勾选 AI 创作声明，然后**停在编辑器**由用户人工核对并自己点发布。' +
      '绝不自动发布。需要先完成一次平台登录（publish_<platform>.py login，登录态持久化在 publish/storage/）。' +
      '不传 article 时自动使用 articles/ 里最新的一篇成稿（优先匹配平台）。' +
      '此工具会驱动真实浏览器并操作账号，需要人工审批。',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: '目标发布平台。',
          enum: [...PLATFORMS],
          default: 'xiaohongshu',
        },
        article: {
          type: 'string',
          description:
            '待发布文章 .md 绝对路径；缺省自动取 articles/ 里最新一篇（优先匹配 platform）。',
        },
        dry_run: {
          type: 'boolean',
          description:
            '预演：填稿到编辑器后即停止（默认行为即停在编辑器，此参数用于更保守的预览）。',
          default: false,
        },
        save_as_draft: {
          type: 'boolean',
          description:
            '仅小红书：点「发布笔记」走官方 AI 声明拦截自动存草稿（默认不点，停在编辑器交人工）。',
          default: false,
        },
      },
      required: [],
    },
    needsApproval: true,
    async execute(args, execCtx: ToolExecutionContext | undefined): Promise<string> {
      const platform = (args.platform as Platform | undefined) ?? 'xiaohongshu'
      let article = (args.article as string | undefined)?.trim() ?? ''

      // Validate cheap user input before touching the (env-driven) PSE dir so a
      // bad platform fails fast instead of a missing-env error.
      if (!(PLATFORMS as readonly string[]).includes(platform)) {
        return `error: hot-news-publish 未知平台「${platform}」；可用: ${PLATFORMS.join(', ')}`
      }

      if (!article) {
        article = (await latestArticle(platform)) ?? ''
      }

      const cmdArgs: string[] = ['publish']
      const env = article ? { ...process.env, HOT_NEWS_ARTICLE: article } : undefined
      if (platform === 'xiaohongshu' && article) cmdArgs.push(`--article=${article}`)
      if (args.dry_run) cmdArgs.push('--dry-run')
      if (args.save_as_draft && platform === 'xiaohongshu') cmdArgs.push('--save-as-draft')

      const res = await runPseScript({
        tool: 'hot-news-publish',
        script: join(hotNewsDir(), 'publish', `publish_${platform}.py`),
        cwd: hotNewsDir(),
        args: cmdArgs,
        env,
        timeoutMs: RUN_TIMEOUT_MS,
        onProgress: execCtx?.onProgress,
        logger: (msg, ...a) => ctx.logger('hot-news-publish').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const body = res.stdout.trim()
      return [
        `> 🔗 hot-news-publish 完成（平台：${platform}，已填好内容停在编辑器，请人工核对后发布）`,
        article ? `> 文章：${article}` : '> 注意：未指定文章，发布端使用 .env 默认路径',
        '',
        body.length > 2500 ? body.slice(-2500) : body,
      ].join('\n')
    },
  } satisfies Tool)
}

export const toolHotNewsPublish = definePlugin(registerHotNewsPublish, 'tool-hot-news-publish', [
  'tools',
])
