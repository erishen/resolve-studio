/**
 * Tasks service — professional tool-set selection by intent.
 *
 * Each *task* bundles a small, purpose-built tool whitelist plus a short system
 * prompt. When the user's latest message matches a task (see `match`), the
 * agent loop narrows what it injects: only the task's tools become visible to
 * the model, keeping the ~dozens of MCP/feature tools out of the context window
 * and its token baseline. Unmatched, open-ended requests fall back to the full
 * toolset.
 *
 * Intent matching is dependency-light heuristics (keyword + tool-name scoring),
 * not a second model call — cheap and deterministic. Match quality matters less
 * than the guardrails the system prompt adds: if a task is mis-selected the
 * model sees few tools and can't misbehave with the rest.
 */

import type { Context } from 'cordis'
import { Service } from 'cordis'
import { definePlugin } from './util.js'

declare module 'cordis' {
  interface Context {
    tasks: TasksService
  }
}

export interface TaskDef {
  /** Stable id (used by the UI / config to reference a task). */
  id: string
  /** Human name. */
  name: string
  /** Shown to the model in the system prompt and used in intent scoring. */
  description: string
  /** Keyword scoring hints (Chinese/English) for intent matching. */
  keywords: string[]
  /** Tools to whitelist for this task (prefix-matched against tool names). */
  includeTools: string[]
  /** Tools to always exclude even if matched by `includeTools`. */
  excludeTools?: string[]
  /** Extra instructions prepended to the run's system prompt while active. */
  systemPrompt?: string
}

export interface TasksConfig {
  /** Custom tasks; merged over the built-in defaults (same id replaces). */
  tasks?: TaskDef[]
  /** Custom capability scopes; merged over the built-ins (same id replaces). */
  scopes?: ToolScopeDef[]
}

/** Core built-ins every task carries so the model can still read/write/act. */
const CORE_TOOLS = ['read-file', 'write-file', 'shell', 'skill-run']
/** Shared file-system MCP server and browser, useful across several tasks. */
const FS_TOOLS = ['fs']
const BROWSER_TOOLS = ['browser-open', 'browser-screenshot']

/**
 * Horizontal capability tiers — not business tasks. They only decide HOW MUCH
 * of the tool surface is injected, independent of the user's intent (which is
 * still auto-matched to the task list). Handy for manually capping toolset
 * breadth/token cost without tying it to a business scenario. `all` (full
 * registry) is implicit: a scope with an empty/includeTools-less filter.
 */
export interface ToolScopeDef {
  id: string
  name: string
  description: string
  /** Whitelist (prefix-matched). No tools listed here is fine but `all` is
   *  represented by an empty includeTools (means "keep everything"). */
  includeTools: string[]
}

const DEFAULT_SCOPES: ToolScopeDef[] = [
  {
    id: 'core',
    name: '仅核心工具',
    description: '只注入 read-file / write-file / shell / skill-run 四个基础工具。',
    includeTools: [...CORE_TOOLS],
  },
  {
    id: 'files',
    name: '核心 + 文件',
    description: '核心工具 + 文件系统（fs 前缀）。',
    includeTools: [...CORE_TOOLS, ...FS_TOOLS],
  },
  {
    id: 'web',
    name: '核心 + 联网',
    description: '核心工具 + 文件系统 + 浏览器（浏览/截图）。',
    includeTools: [...CORE_TOOLS, ...FS_TOOLS, ...BROWSER_TOOLS],
  },
]

const DEFAULT_TASKS: TaskDef[] = [
  {
    id: 'articles',
    name: '技术文章写作与发布',
    description:
      '扫描 github 项目、用 crewai-pse 三角色流水线生成中英双语技术文章草稿、校验并发布到 WordPress（掘金/思否/微信草稿）。',
    keywords: [
      '文章',
      '写作',
      '博客',
      '发布',
      'wordpress',
      '技术文章',
      '稿子',
      '干货',
      '发布到',
      '掘金',
      '思否',
      '公众号',
      '微信',
      '双语',
      '中英',
      '草稿',
      '投稿',
      '写一篇',
      '博客文章',
    ],
    includeTools: [
      ...CORE_TOOLS,
      'article-discover',
      'article-write',
      'article-validate',
      'article-publish',
      'article-archive',
      'juejin-draft',
      'wechat-draft',
      'sf-pw-publish',
      'pick-post',
    ],
  },
  {
    id: 'hotnews',
    name: '热点营销内容',
    description:
      '抓取热门新闻素材、列候选话题、生成小红书等热点文案、校验合规（限值/违禁词/AI 声明）。',
    keywords: [
      '热点',
      '热搜',
      '新闻',
      '微博',
      '话题',
      '小红书',
      '营销',
      '内容生成',
      '素材',
      '文案',
      '合规',
      '违禁',
      '引流',
      '爆款',
      '种草',
      '今日头条',
      '抖音',
      '热搜榜',
      '热门话题',
    ],
    includeTools: [
      ...CORE_TOOLS,
      ...FS_TOOLS,
      'hot-news-fetch',
      'hot-news-topics',
      'hot-news',
      'hot-news-check',
      'hot-news-publish',
    ],
  },
  {
    id: 'investment',
    name: '投资分析',
    description:
      '全市场技术信号扫描、CSV 数据分析、产品与竞品分析、投资组合周度分析，产出本地 JSON/Markdown/HTML 报告。',
    keywords: [
      '投资',
      '股票',
      '行情',
      '市场',
      '信号',
      '组合',
      '周报',
      '持仓',
      'csv',
      '产品分析',
      '竞品',
      '分析',
      '投资组合',
      '持仓分析',
      '股票分析',
      '市场分析',
      '数据',
      '财报',
      '估值',
    ],
    includeTools: [
      ...CORE_TOOLS,
      ...FS_TOOLS,
      'stock-scan',
      'csv-analyze',
      'product-analyze',
      'portfolio-check',
      'pse-review',
    ],
  },
  {
    id: 'foundation',
    name: '通用分析目录',
    description:
      '分析文件或代码目录的结构、内容与依赖，理解一个代码库/文件夹后再回答；提供系统信息与通用计算。',
    keywords: [
      '目录',
      '文件夹',
      '代码库',
      '分析这个目录',
      '看看这个项目',
      '理解代码',
      '代码结构',
      '系统信息',
      '软件环境',
      '计算',
    ],
    includeTools: [
      ...CORE_TOOLS,
      ...FS_TOOLS,
      'analyze-dir',
      'analyze-code-dir',
      'pse-review',
      'system-info',
      'calculator',
    ],
  },
  {
    id: 'privacy',
    name: '隐私与合规自查',
    description:
      '审计当前 repo 是否有隐私泄露（.gitignore 覆盖/硬编码密钥/历史提交敏感文件等 9 项检查），PDF 转 Markdown。',
    keywords: [
      '隐私',
      '泄露',
      '审计',
      '安全',
      '密钥',
      '敏感',
      '自查',
      'repo',
      '合规',
      'pdf',
      '泄漏',
      '硬编码',
      '密钥检查',
      '安全审计',
      'secret',
      'token',
    ],
    includeTools: [...CORE_TOOLS, ...FS_TOOLS, 'privacy-audit'],
  },
  {
    id: 'documents',
    name: '文档与资料库检索',
    description:
      '在本地 markdown 文档库全文检索、查照片重复、批量 Word 转 Markdown，基于本地只读服务。',
    keywords: [
      '文档库',
      '资料库',
      '搜索',
      '检索',
      'markdown',
      '文档',
      '照片',
      '重复',
      'word',
      '转换',
      'doc',
      '查找文件',
      '查找资料',
      '资料查询',
      '文档搜索',
      'md',
      '批量转换',
    ],
    includeTools: [
      ...CORE_TOOLS,
      ...FS_TOOLS,
      'doc-library-search',
      'photo-duplicates',
      'video-library-list',
    ],
  },
  {
    id: 'recruiting',
    name: '简历与求职',
    description: '定制简历、生成面试题、记录 CRM 求职任务。',
    keywords: [
      '简历',
      '求职',
      '面试',
      '面试题',
      'crm',
      '招聘',
      'tailor',
      '改简历',
      '优化简历',
      '准备面试',
      '模拟面试',
      '招聘任务',
    ],
    includeTools: [...CORE_TOOLS, ...FS_TOOLS, 'resume-tailor', 'interview-questions', 'crm-task'],
  },
  {
    id: 'web',
    name: '联网调研',
    description: '浏览网页、抓取并总结外部信息。',
    keywords: [
      '打开网页',
      '浏览',
      '查询',
      '百度',
      'google',
      '官网',
      '搜索一下',
      '调研',
      '网站',
      '打开网站',
      '浏览网页',
      '上网查',
      '查一下',
      '搜索资料',
      '网络调研',
      '网页内容',
      '爬虫',
    ],
    includeTools: [...CORE_TOOLS, ...FS_TOOLS, ...BROWSER_TOOLS],
  },
]

/** Simple whitespace/coverage tokenizer for keyword scoring. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,，。；;、:：()（）"'“”‘’/\\_-]+/)
    .filter(Boolean)
}

/**
 * Weight a task keyword by how *specific* it is. Short generic words ("文章",
 * "分析", "搜索", "doc") appear across domains and should not dominate; longer
 * phrases ("技术文章", "文档库", "投资分析") are intent-bearing and count more.
 * This keeps a single generic hit from out-scoring a genuinely targeted one.
 */
function keywordWeight(keyword: string): number {
  return keyword.trim().length >= 3 ? 2 : 1
}

export class TasksService extends Service {
  private readonly tasks: TaskDef[]
  private readonly scopes: ToolScopeDef[]

  constructor(ctx: Context, config: TasksConfig = {}) {
    super(ctx, 'tasks')
    const defaults = new Map(DEFAULT_TASKS.map((t) => [t.id, { ...t }]))
    for (const t of config.tasks ?? []) defaults.set(t.id, { ...defaults.get(t.id), ...t })
    this.tasks = [...defaults.values()]
    const scopeDefaults = new Map(DEFAULT_SCOPES.map((s) => [s.id, { ...s }]))
    for (const s of config.scopes ?? [])
      scopeDefaults.set(s.id, { ...scopeDefaults.get(s.id), ...s })
    this.scopes = [...scopeDefaults.values()]
    ctx
      .logger('tasks')
      .info('registered %d task(s), %d scope(s)', this.tasks.length, this.scopes.length)
  }

  /** All registered tasks. */
  list(): TaskDef[] {
    return this.tasks.map((t) => ({ ...t, keywords: [...t.keywords] }))
  }

  /** Horizontal capability tiers (not business tasks). */
  listScopes(): ToolScopeDef[] {
    return this.scopes.map((s) => ({ ...s, includeTools: [...s.includeTools] }))
  }

  /** Look up a capability scope by id. */
  getScope(id: string): ToolScopeDef | undefined {
    return this.scopes.find((s) => s.id === id)
  }

  /** Look up a task by id, or undefined when not registered. */
  get(id: string): TaskDef | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  /**
   * Score a user message against a task: each task keyword found in the message
   * adds weight; a message token matching a tool name in the task adds more.
   * Returns the best task, or undefined when no keyword hits.
   */
  match(message: string): TaskDef | undefined {
    const hay = message.toLowerCase()
    const msgTokens = tokens(message)
    let best: { task: TaskDef; score: number; taskHits: number } | undefined
    for (const task of this.tasks) {
      let score = 0
      let hits = 0
      for (const kw of task.keywords) {
        if (hay.includes(kw.toLowerCase())) {
          score += keywordWeight(kw)
          hits += 1
        }
      }
      for (const tok of msgTokens) {
        if (task.includeTools.some((t) => t === tok)) {
          score += 5
          hits += 1
        }
      }
      // A task carrying more distinct matching keywords is more focused than one
      // that merely overlaps on a single generic term — use it to break ties.
      if (
        score > 0 &&
        (!best || score > best.score || (score === best.score && hits > best.taskHits))
      ) {
        best = { task, score, taskHits: hits }
      }
    }
    return best?.task
  }

  /** Agent-run options derived from an active task (tool whitelist + hint). */
  agentOptions(task: TaskDef): {
    includeTools: string[]
    excludeTools?: string[]
    systemPrompt?: string
  } {
    const systemPrompt = [
      `当前任务：${task.name}`,
      `任务说明：${task.description}`,
      '你只能使用本任务提供给的工具。如果用户的请求超出了这些工具的能力，明确告知做不到并说明原因，不要臆造或强行复用其他工具。',
      task.systemPrompt,
    ]
      .filter(Boolean)
      .join('\n')
    return {
      includeTools: task.includeTools,
      excludeTools: task.excludeTools,
      systemPrompt,
    }
  }

  /**
   * Resolve a run's tool filter + optional guardrail prompt from a `taskId`.
   *
   * - `'auto'` / `undefined`: intent-match the latest user message against the
   *   business tasks (falls back to full registry when nothing matches).
   * - a scope id (core / files / web / …): apply that horizontal capability
   *   tier's whitelist — no business system prompt, since it's not a scenario.
   * - a business task id: apply that task's whitelist + guardrail prompt.
   * - anything else (unknown id): `undefined` → caller keeps full toolset.
   */
  resolve(
    taskId: string | undefined,
    messages: { role: string; content: unknown }[],
  ): { includeTools: string[]; excludeTools?: string[]; systemPrompt?: string } | undefined {
    if (typeof taskId === 'string' && taskId !== 'auto') {
      const scope = this.getScope(taskId)
      if (scope) {
        // A scope with no whitelist means "full registry" (all tools).
        return scope.includeTools.length ? { includeTools: scope.includeTools } : undefined
      }
      const task = this.get(taskId)
      return task ? this.agentOptions(task) : undefined
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    if (lastUser && typeof lastUser.content === 'string') {
      const task = this.match(lastUser.content)
      return task ? this.agentOptions(task) : undefined
    }
    return undefined
  }
}

export const tasks = definePlugin(TasksService, 'tasks', [])
