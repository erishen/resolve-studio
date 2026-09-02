import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

// …/resolve-studio/packages/core/src/plugins/tools, 8 levels up = the workspace
// root hosting ***REMOVED***/. Override with MARKDOWN_LIBRARY_URL in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = resolve(HERE, '***REMOVED******REMOVED***/markdown-library')
const BASE_URL = process.env.MARKDOWN_LIBRARY_URL ?? 'http://127.0.0.1:3100'

// The service is a long-running local REST server. Guard each call with a cheap
// /health probe so a stopped service yields a useful "start it" hint instead of
// a confusing fetch ECONNREFUSED.
const registerDocLibrarySearch = (ctx: Context) => {
  ctx.tools.register({
    name: 'doc-library-search',
    description:
      '本地 Markdown 文档库全文检索（markdown-library，只读）：FTS5 命中片段检索 + 可选坏链/健康检查。' +
      '用于"在我的 markdown 文档库里搜一下 xxx"。' +
      '服务默认 http://127.0.0.1:3100（未运行时返回启动指引）。',
    parameters: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: '检索关键词（FTS5 全文检索）。',
        },
        check_broken: {
          type: 'boolean',
          description: '同时返回坏链检查结果（/api/broken，需先扫描过）。',
          default: false,
        },
      },
      required: ['q'],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const q = (args.q as string | undefined)?.trim()
      if (!q) return 'error: doc-library-search 需要 q 参数（检索词）。'

      const probe = await fetchJson(`${BASE_URL}/health`)
      if (!probe.ok) {
        return (
          `error: markdown-library 服务未运行（${BASE_URL}/health 不可达）。\n` +
          `启动：cd ${LIB_DIR} && make run（需先 cp .env.example .env）`
        )
      }

      const out: string[] = []
      const res = await fetchJson(`${BASE_URL}/docs?q=${encodeURIComponent(q)}`)
      const items = (res.data as { docs?: unknown } | undefined)?.docs ?? []
      const rows = Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []
      out.push(`检索「${q}」命中 ${rows.length} 篇：`, '')
      for (const d of rows.slice(0, 20)) {
        const title = d.title ?? d.name ?? d.path ?? '?'
        const snippet = d.snippet ?? d.excerpt ?? ''
        out.push(`- **${title}**${d.updated_at ? `（${d.updated_at}）` : ''}`)
        if (snippet) out.push(`  ${String(snippet).slice(0, 160)}`)
      }
      if (!rows.length) out.push('（无命中）')

      if (args.check_broken) {
        const b = await fetchJson(`${BASE_URL}/broken`)
        const broken = Array.isArray(b.data) ? (b.data as Array<Record<string, unknown>>) : []
        out.push(
          '',
          `坏链检查：${broken.length} 个坏链`,
          ...broken.slice(0, 10).map((x) => `  - ${x.path ?? x.from ?? String(x)}`),
        )
      }

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

export const toolDocLibrarySearch = definePlugin(
  registerDocLibrarySearch,
  'tool-doc-library-search',
  ['tools'],
)
