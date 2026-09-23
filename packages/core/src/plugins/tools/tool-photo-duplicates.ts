import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const BASE_URL = process.env.PHOTO_LIBRARY_URL ?? 'http://127.0.0.1:3100'

/** photo-library 的 API key（服务端配置了 API_KEY 时，非本机访问需带 x-api-key）。 */
const PHOTO_LIBRARY_KEY = process.env.PHOTO_LIBRARY_KEY ?? ''

/** Root of the photo-library service, from PHOTO_LIBRARY_DIR (env-only). */
function photoLibraryDir(): string {
  return process.env.PHOTO_LIBRARY_DIR ?? ''
}

const registerPhotoDuplicates = (ctx: Context) => {
  ctx.tools.register({
    name: 'photo-duplicates',
    description:
      '本地照片库重复/相似检查（photo-library，只读）：返回重复分组与库统计。' +
      '用于"照片库里有没有重复的照片"。' +
      '服务默认 http://127.0.0.1:3100（未运行时返回启动指引）。',
    parameters: {
      type: 'object',
      properties: {
        similar: {
          type: 'boolean',
          description: '同时返回相似照片分组（/api/similar）。',
          default: false,
        },
        stats: {
          type: 'boolean',
          description: '返回库统计（/api/stats）。',
          default: true,
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const probe = await fetchJson(`${BASE_URL}/health`)
      if (!probe.ok) {
        return (
          `error: photo-library 服务未运行（${BASE_URL}/health 不可达）。\n` +
          `启动：cd ${photoLibraryDir() || '<photo-library 根目录 (设置 PHOTO_LIBRARY_DIR)>'} && make run（需先 cp .env.example .env）`
        )
      }

      const out: string[] = []
      if (args.stats) {
        const s = await fetchJson(`${BASE_URL}/api/stats`)
        const st = (s.data ?? {}) as Record<string, unknown>
        out.push(
          `📊 照片库统计：${st.unique_images ?? st.total_images ?? '?'} 张（去重后）` +
            ` / 重复 ${st.duplicate_groups ?? '?'} 组（${st.duplicate_images ?? '?'} 张）` +
            ` / 相似 ${st.similar_groups ?? '?'} 组（${st.similar_images ?? '?'} 张）`,
          '',
        )
      }

      const d = await fetchJson(`${BASE_URL}/api/duplicates`)
      const dPage = (d.data ?? {}) as {
        items?: Array<{
          content_hash?: string
          count?: number
          items?: Array<{ relative_path?: string; name?: string }>
        }>
      }
      const dupGroups = Array.isArray(dPage.items) ? dPage.items : []
      if (!dupGroups.length) {
        out.push('✅ 无重复照片（content 哈希去重）')
      } else {
        out.push(`重复照片 ${dupGroups.length} 组：`)
        for (const g of dupGroups.slice(0, 15)) {
          const items = Array.isArray(g.items) ? g.items : []
          out.push(`- ${g.content_hash ?? ''} (${g.count ?? items.length} 张)`)
          for (const f of items.slice(0, 3)) {
            out.push(`  - ${f.relative_path ?? f.name ?? String(f)}`)
          }
        }
      }

      if (args.similar) {
        const si = await fetchJson(`${BASE_URL}/api/similar`)
        const sPage = (si.data ?? {}) as { items?: unknown[] }
        const sg = Array.isArray(sPage.items) ? sPage.items : []
        out.push('', `相似照片（感知哈希）${sg.length} 组`)
      }

      return out.join('\n')
    },
  } satisfies Tool)
}

async function fetchJson(url: string): Promise<{ ok: boolean; data?: unknown }> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 4000)
    const headers = PHOTO_LIBRARY_KEY ? { 'x-api-key': PHOTO_LIBRARY_KEY } : undefined
    const res = await fetch(url, { signal: ctrl.signal, headers })
    clearTimeout(timer)
    if (!res.ok) return { ok: false }
    return { ok: true, data: await res.json() }
  } catch {
    return { ok: false }
  }
}

export const toolPhotoDuplicates = definePlugin(registerPhotoDuplicates, 'tool-photo-duplicates', [
  'tools',
])
