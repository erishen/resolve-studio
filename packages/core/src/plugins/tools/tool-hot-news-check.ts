import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { resolveTaskDir, runPseScript } from './util-pse.js'
import type { Tool } from '../../types.js'

// Offline pre-publish validation for a hot-news draft: article frontmatter
// fields + platform title/body limits + banned words + AI-label rule. Each
// platform publisher ships a `check` subcommand (publish_xiaohongshu.py has
// `--article`; zhihu/toutiao read HOT_NEWS_ARTICLE from the env instead).
const hotNewsDir = () => resolveTaskDir('llamaindex', 'hot-news')
const articlesDir = () => join(hotNewsDir(), 'articles')

/**
 * 找最新一篇已生成的热点稿。优先匹配目标平台（文件名含 _<platform>_），
 * 再退回任意 hot_news_*.md；文件名带 YYYYMMDD_HHMMSS 时间戳，字典序即时间序。
 * 兜底 .env 的 HOT_NEWS_ARTICLE 是陈旧的，容易校验到旧稿，故不优先用它。
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

const registerHotNewsCheck = (ctx: Context, _config: Record<string, never> = {}) => {
  ctx.tools.register({
    name: 'hot-news-check',
    description:
      '离线校验一篇热点稿：文章字段（标题/正文/封面/来源标注）+ 平台限值 + 违禁词 + AI 声明要求。' +
      '不联网、不发布，发布到小红书/知乎/头条前先跑一遍。' +
      '不传 article 时自动使用 articles/ 里最新的一篇成稿（优先匹配平台）。',
    parameters: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: '目标发布平台（决定限值/标签结构）。',
          enum: [...PLATFORMS],
          default: 'xiaohongshu',
        },
        article: {
          type: 'string',
          description:
            '待校验文章 .md 绝对路径；缺省自动取 articles/ 里最新一篇（优先匹配 platform）。',
        },
      },
      required: [],
    },
    async execute(args, execCtx): Promise<string> {
      const platform = (args.platform as Platform | undefined) ?? 'xiaohongshu'
      let article = (args.article as string | undefined)?.trim() ?? ''

      // Validate cheap user input before touching the (env-driven) PSE dir so a
      // bad platform fails fast instead of a missing-env error.
      if (!(PLATFORMS as readonly string[]).includes(platform)) {
        return `error: hot-news-check 未知平台「${platform}」；可用: ${PLATFORMS.join(', ')}`
      }

      if (!article) {
        article = (await latestArticle(platform)) ?? ''
      }

      const runArgs: string[] = ['check']
      const env = article ? { ...process.env, HOT_NEWS_ARTICLE: article } : undefined
      if (platform === 'xiaohongshu' && article) runArgs.push(`--article=${article}`)

      const res = await runPseScript({
        tool: 'hot-news-check',
        script: join(hotNewsDir(), 'publish', `publish_${platform}.py`),
        cwd: hotNewsDir(),
        args: runArgs,
        env,
        onProgress: execCtx?.onProgress,
        logger: (msg, ...a) => ctx.logger('hot-news-check').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const body = res.stdout.trim()
      return [
        `> ✅ hot-news-check 完成（平台：${platform}，离线校验，无需联网）`,
        article ? `> 校验文章：${article}` : '> 注意：未找到成稿，使用发布端 .env 的默认文章路径',
        '',
        body.length > 2500 ? body.slice(-2500) : body,
      ].join('\n')
    },
  } satisfies Tool)
}

export const toolHotNewsCheck = definePlugin(registerHotNewsCheck, 'tool-hot-news-check', ['tools'])
