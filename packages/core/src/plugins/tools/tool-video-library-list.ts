import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = resolve(HERE, '***REMOVED******REMOVED***/video-library')
const BASE_URL = process.env.VIDEO_LIBRARY_URL ?? 'http://127.0.0.1:3200'

const registerVideoLibraryList = (ctx: Context) => {
  ctx.tools.register({
    name: 'video-library-list',
    description:
      '本地视频库清单（video-library，只读）：列出已索引视频（编解码/分辨率/时长/大小）。' +
      '用于"视频库里有哪些视频，帮我列个清单"。' +
      '服务默认 http://127.0.0.1:3200（未运行时返回启动指引）。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '最多返回条数（默认 30）。',
          default: 30,
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const probe = await fetchJson(`${BASE_URL}/health`)
      if (!probe.ok) {
        return (
          `error: video-library 服务未运行（${BASE_URL}/health 不可达）。\n` +
          `启动：cd ${LIB_DIR} && make run（需先 cp .env.example .env）`
        )
      }

      const limit = (args.limit as number | undefined) ?? 30
      const res = await fetchJson(`${BASE_URL}/videos?limit=${limit}`)
      const videos = ((res.data as { items?: unknown } | undefined)?.items ??
        res.data ??
        []) as Array<Record<string, unknown>>

      const out: string[] = [
        `视频库共 ${videos.length} 条（展示前 ${Math.min(limit, videos.length)} 条）：`,
        '',
      ]
      for (const v of videos.slice(0, limit)) {
        const name = v.name ?? v.title ?? v.path ?? '?'
        const dur = v.duration_sec ?? v.duration ?? ''
        const codec = v.video_codec ?? v.codec ?? ''
        const reso = v.resolution ?? (v.width && v.height ? `${v.width}x${v.height}` : '')
        out.push(
          `- **${name}**${dur ? ` ⏱${dur}s` : ''}${codec ? ` [${codec}]` : ''}${reso ? ` ${reso}` : ''}`,
        )
      }
      if (!videos.length) out.push('（库为空，先扫描再查询）')

      return out.join('\n')
    },
  } satisfies Tool)
}

async function fetchJson(url: string): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return { ok: false }
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false }
  }
}

export const toolVideoLibraryList = definePlugin(
  registerVideoLibraryList,
  'tool-video-library-list',
  ['tools'],
)
