/**
 * `publish-pending` tool — 只读：按平台列出「还没发出去」的文章。
 *
 * 数据源是 life-dash 生成的 src/data/articlePublish.json（make export-pending /
 * rescan 同源刷新）。它把「各平台未发清单」变成卡片任务里可直接看到的内容：
 * 每条 = 标题 + 缺哪个平台 + 该平台的下一步动作（建草稿 / 点发布 / 补英文稿）。
 * 公众号走「建进草稿箱即视为已群发」的工作流语义：make wechat-draft 建草稿自动升 pub，
 * 不再有「待群发」中间态；未建草稿但确认发过的 base 进 wechat-sent.json 白名单。
 *
 * 与 wechat-draft / juejin-draft 的区别：那些工具是「执行一次发布动作」（会写
 * frontmatter）；本工具是「先把全貌摊开」——回答"到底还有哪些没发、下一步各该做
 * 什么"。它只读，永不写，因此不进审批门、可反复调用。
 *
 * LIFE_DASH_DIR（.env，gitignored）指向 life-dash 仓库根；缺省则按 WORDPRESS_TOOLS_DIR
 * 向上推（…/personal-site/wordpress-tools → 同级 personal/life-dash）。
 */
import type { Context } from 'cordis'
import type { Tool, ToolExecutionContext } from '../../types.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { definePlugin } from '../util.js'

const LIFE_DASH = process.env.LIFE_DASH_DIR
const WP_TOOLS = process.env.WORDPRESS_TOOLS_DIR
const PENDING_REL = join('src', 'data', 'articlePublish.json')

function pendingFile(): string | null {
  const base = LIFE_DASH
  if (base) return join(base, PENDING_REL)
  // 无 LIFE_DASH_DIR 时的兜底：wordpress-tools 与 life-dash 同处 personal/ 下
  if (WP_TOOLS) return join(WP_TOOLS, '..', '..', 'life-dash', PENDING_REL)
  return null
}

interface PRow {
  base: string
  title: string
  pse?: boolean
  wp: { s: string }
  en: { s: string }
  juejin: { s: string }
  sf: { s: string }
  wechat: { s: string }
  missing: string[]
}
interface PendingData {
  summary?: {
    total?: number
    full?: number
    missingWp?: number
    missingEn?: number
    jjNotPub?: number
    sfNotPub?: number
    wcNoConv?: number
  }
  queue?: Array<{ plat: string; label: string; pending: number; nextCmd: string; note: string }>
  rows?: PRow[]
  orphans?: string[]
}

// 各平台状态 → 人类可读的「该做什么」
const NEXT_STEP: Record<string, string> = {
  'wp:missing': 'WP 发布（writeArticle.js）',
  'en:missing': '写英文稿（articles/en/…-en.md）',
  'juejin:draft': '草稿已建 → 点发布（make juejin-publish）',
  'juejin:missing': '建草稿（make juejin-draft）或补掘金稿',
  'segmentfault:draft': '已写未发 → 发布（make sf-pw-publish）',
  'segmentfault:missing': '补思否稿并发布（make sf-pw-publish）',
  'wechat:missing': '建公众号草稿（make wechat-draft）——建进草稿箱即视为已群发',
  'wechat:conv': '已转换未建草稿 → 建草稿（make wechat-draft）——建草稿即视为已群发',
}

function run(_args: Record<string, never>, execCtx?: ToolExecutionContext): string {
  const file = pendingFile()
  if (!file || !existsSync(file)) {
    return (
      `error: 未找到未发清单数据源。\n` +
      `需要 LIFE_DASH_DIR（.env）指向 life-dash 仓库根，且其 src/data/articlePublish.json 已生成。\n` +
      `先在 life-dash 跑 make export-pending（或 rescan）生成，再调用本工具。`
    )
  }
  let d: PendingData
  try {
    d = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return `error: 解析 ${file} 失败：${(e as Error).message}`
  }
  const rows = d.rows ?? []
  const s = d.summary ?? {}

  const lines: string[] = []
  lines.push(
    `> 各平台未发清单（读 ${file}，共 ${s.total ?? rows.length} 篇中文原稿，五端全齐 ${s.full ?? 0} 篇）`,
  )
  lines.push('')
  lines.push('各平台待办与下一步（对应卡片任务）：')

  // 每平台：挑出"该平台还没落地"的行，给标题 + 该做啥
  const emit = (label: string, items: PRow[], stepBy: (r: PRow) => string, hint?: string) => {
    if (items.length === 0) {
      lines.push(`• ${label}：无待办 ✓`)
      return
    }
    lines.push(`• ${label}（${items.length} 篇待办）：`)
    for (const r of items.slice(0, 15)) {
      lines.push(`    - ${r.title}${r.pse ? '（pse）' : ''}  →  ${stepBy(r)}`)
    }
    if (items.length > 15) lines.push(`    … 其余 ${items.length - 15} 篇省略`)
    if (hint) lines.push(`    💡 ${hint}`)
  }

  emit(
    '掘金',
    rows.filter((r) => r.missing.includes('juejin')),
    (r) => NEXT_STEP[`juejin:${r.juejin.s}`] ?? '发布',
    (s.jjNotPub ?? 0) > 0 ? '草稿已建的直接 make juejin-publish 点发布' : undefined,
  )
  emit(
    '思否',
    rows.filter((r) => r.sf.s !== 'pub'),
    (r) => NEXT_STEP[`segmentfault:${r.sf.s}`] ?? '发布',
    '有稿未发的走 make sf-pw-publish（Playwright）',
  )
  emit(
    '公众号·未建草稿',
    rows.filter((r) => r.wechat.s === 'conv' || r.wechat.s === 'missing'),
    (r) => NEXT_STEP[`wechat:${r.wechat.s}`] ?? '建草稿',
    `make wechat-draft 建草稿（逐篇）即视为已群发（工作流语义）；没建草稿但确认发过的，把 base 加进 wechat-sent.json 白名单`,
  )
  emit(
    '英文稿',
    rows.filter((r) => r.missing.includes('en')),
    () => NEXT_STEP['en:missing'],
    '需人工写英文稿，非卡片可自动完成',
  )

  const queue = d.queue ?? []
  if (queue.length) {
    lines.push('')
    lines.push('各平台「下一步命令」（复制即用）：')
    for (const q of queue) {
      lines.push(`  [${q.label} 待办 ${q.pending}] ${q.nextCmd}`)
    }
  }
  return lines.join('\n')
}

const tool: Tool = {
  name: 'publish-pending',
  description:
    '列出「各平台还没发出去」的文章（只读）：读 life-dash 的未发清单，按掘金/思否/公众号/英文稿分组，给每篇该做什么（建草稿/点发布/群发/补稿）。它只读、不写、不进审批门。⚠️ 要真正发出去请用对应的卡片任务（juejin-publish / sf-pw-publish / wechat-draft）；本工具只是把全貌摊开。',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(args, execCtx) {
    return run(args as Record<string, never>, execCtx)
  },
}

export const toolPublishPending = definePlugin(
  (ctx: Context) => {
    ctx.tools.register(tool)
    ctx.logger('publish-pending').info('registered publish-pending (read-only pending-list)')
  },
  'tool-publish-pending',
  ['tools'],
)
