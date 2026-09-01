import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { resolveTaskDir, runPseScript } from './util-pse.js'
import type { Tool } from '../../types.js'

// Reads the hot-news task's `run.py --list-topics`, which ranks the weibo hot
// list by traffic and pairs each candidate with its news grounding. Read-only.
const hotNewsDir = () => resolveTaskDir('llamaindex', 'hot-news')
const newsDir = () => join(hotNewsDir(), 'news')

const registerHotNewsTopics = (ctx: Context, _config: Record<string, never> = {}) => {
  ctx.tools.register({
    name: 'hot-news-topics',
    description:
      '列出当前可写的话题候选：微博热搜（按热度降序）+ qbitai/infoq AI 科技源（按发布时间降序）。' +
      'AI 相关选题优先看 AI 科技源候选（qbitai/infoq）。' +
      '数据来自已抓取的 news/ 快照（需先跑 hot-news-fetch 刷新）；只读，不写任何文件，无需审批。',
    parameters: {
      type: 'object',
      properties: {
        news_dir: {
          type: 'string',
          description: `新闻快照目录（默认 ${newsDir()}）。`,
        },
      },
      required: [],
    },
    async execute(args, execCtx): Promise<string> {
      const dir = (args.news_dir as string | undefined)?.trim() || newsDir()
      try {
        await access(dir)
      } catch {
        return `error: hot-news-topics 未找到新闻快照目录 ${dir} —— 请先调用 hot-news-fetch 抓取素材。`
      }

      const res = await runPseScript({
        tool: 'hot-news-topics',
        script: join(hotNewsDir(), 'run.py'),
        cwd: hotNewsDir(),
        args: ['--list-topics', `--news-dir=${dir}`],
        onProgress: execCtx?.onProgress,
        logger: (msg, ...a) => ctx.logger('hot-news-topics').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const body = res.stdout.trim()
      return [
        `> 📋 热点话题候选（来源：${dir}）`,
        '',
        body.length > 6000 ? body.slice(-6000) : body,
        '',
        '> 挑选一条标题告诉 hot-news（主题 + 目标平台 + 品类），即可生成合规文案；生成后可再 hot-news-check 校验。',
      ].join('\n')
    },
  } satisfies Tool)
}

export const toolHotNewsTopics = definePlugin(registerHotNewsTopics, 'tool-hot-news-topics', [
  'tools',
])
