import type { SkillInfo } from './api'
import type { ToolSchema } from './types'

export type ExampleCategory = 'article' | 'invest' | 'interview' | 'crm' | 'pse' | 'code' | 'other'

export interface ExampleItem {
  id: string
  /** Short label shown on the card (usually the tool/skill name). */
  title: string
  /** The actual prompt that gets dropped into the input when picked. */
  prompt: string
  /** Category for grouped display. */
  category: ExampleCategory
}

export const CATEGORY_LABELS: Record<ExampleCategory, string> = {
  article: '文章写作',
  invest: '投资分析',
  interview: '面试求职',
  crm: 'CRM 相关',
  pse: 'PSE 三角色',
  code: '代码工具',
  other: '其他',
}

export const CATEGORY_ORDER: ExampleCategory[] = ['article', 'invest', 'interview', 'crm', 'pse', 'code', 'other']

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

function skillExample(s: SkillInfo): ExampleItem | null {
  const blob = (s.name + ' ' + (s.description ?? '')).toLowerCase()
  let prompt: string
  let category: ExampleCategory = 'other'
  // Investment / finance skills take priority over generic "review" matching.
  if (/invest|portfolio|stock|asset|finance|wealth|weekly.*review|投资|持仓|资产/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，生成一份投资组合分析或周度复盘报告。`
    category = 'invest'
  } else if (/article|post|comment|blog|publish|draft|文章|评论|发布|草稿|写作/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，完成文章相关的操作（写文章、发布、评论等）。`
    category = 'article'
  } else if (/review|audit|lint/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，对当前改动做一次审查，并给出可落地的改进建议。`
    category = 'code'
  } else if (/research|investigat|survey|search/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，调研相关主题并整理出结论与参考。`
  } else if (/summar/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，总结指定内容的要点。`
  } else if (/generat|create|build|write|draft/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，帮我生成所需的内容或代码。`
    category = 'code'
  } else if (/fix|debug|repair|resolve/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，定位并修复存在的问题。`
    category = 'code'
  } else if (/explain|analy/.test(blob)) {
    prompt = `请使用 ${s.name} 技能，分析并解释其中的原理。`
    category = 'code'
  } else {
    prompt = `请使用 ${s.name} 技能完成相关任务。`
  }
  return { id: 'skill:' + s.name, title: humanize(s.name), prompt, category }
}

function toolExample(t: ToolSchema): ExampleItem | null {
  const blob = (t.name + ' ' + (t.description ?? '')).toLowerCase()

  // Curated, name-keyed examples. Match by NAME (not description) to avoid
  // cross-talk — e.g. article-discover's description mentions "article-publish",
  // and "已发布文章" contains the substring "发布文章", both mis-route via the
  // loose description regexes below.
  const CURATED: Record<string, { prompt: string; category: ExampleCategory }> = {
    'article-write': { prompt: '帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。', category: 'article' },
    'article-validate': { prompt: '帮我校验一下待发布文章的正确性，看看有没有问题。', category: 'article' },
    'article-publish': { prompt: '请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。', category: 'article' },
    'article-archive': { prompt: '帮我归档一篇文章，重建各平台副本并更新关键词索引。', category: 'article' },
    'article-discover': { prompt: '帮我扫描一下有哪些 github 项目可以写技术文章。', category: 'article' },
    'juejin-draft': { prompt: '帮我把下一篇未发布的文章建成掘金草稿。', category: 'article' },
    'wechat-draft': { prompt: '帮我把下一篇未发布的文章建成微信公众号草稿箱草稿。', category: 'article' },
    'sf-pw-publish': { prompt: '帮我把下一篇未发布的文章发布到思否（用 Playwright 真浏览器）。', category: 'article' },
    'pick-post': { prompt: '帮我随机选一篇已发布的技术文章，我想给它写条评论。', category: 'article' },
    'pse-review': { prompt: '帮我做一份深度投资组合分析，用 autogen-pse 的 PSE 三角色流水线生成。', category: 'invest' },
    'portfolio-summary': { prompt: '帮我做一份当前投资组合的快速概览，包括持仓、收益和风险分布。', category: 'invest' },
    'resume-tailor': { prompt: '帮我定制一份简历，目标岗位 JD：资深后端工程师，要求 5 年以上 Java/Python 经验，熟悉分布式系统和微服务架构。', category: 'interview' },
    'interview-questions': { prompt: '帮我生成一份 Python 后端工程师的技术面试题库，包含基础、进阶、难题各 3 道。', category: 'interview' },
    'crm-task': { prompt: '帮我生成一份本周的 CRM 关系复盘，看看哪些联系人需要跟进。', category: 'crm' },
    'skill-run': { prompt: `调用 ${t.name} 来完成任务。`, category: 'other' },
  }
  const curated = CURATED[t.name]
  if (curated) return { id: 'tool:' + t.name, title: humanize(t.name), prompt: curated.prompt, category: curated.category }

  let prompt: string
  let category: ExampleCategory = 'code'

  if (/article.*write|write.*article|article-write/.test(blob)) {
    prompt = '帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。'
    category = 'article'
  } else if (/juejin.*draft|juejin-draft|掘金.*草稿/.test(blob)) {
    prompt = '帮我把下一篇未发布的文章建成掘金草稿。'
    category = 'article'
  } else if (/wechat.*draft|wechat-draft|微信.*草稿|公众号.*草稿/.test(blob)) {
    prompt = '帮我把下一篇未发布的文章建成微信公众号草稿箱草稿。'
    category = 'article'
  } else if (/sf.*pw.*publish|sf-pw-publish|思否.*发布|segmentfault.*发布/.test(blob)) {
    prompt = '帮我把下一篇未发布的文章发布到思否（用 Playwright 真浏览器）。'
    category = 'article'
  } else if (/pick.*post|pick-post|选文章|挑文章|随机.*文章/.test(blob)) {
    prompt = '帮我随机选一篇已发布的技术文章，我想给它写条评论。'
    category = 'article'
  } else if (/article.*publish|article-publish|发布文章|publish.*wordpress/.test(blob)) {
    prompt = '请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。'
    category = 'article'
  } else if (/article.*archive|article-archive|归档文章|archive.*article/.test(blob)) {
    prompt = '帮我归档一篇文章，重建各平台副本并更新关键词索引。'
    category = 'article'
  } else if (/article.*validate|article-validate|校验文章|发布前校验/.test(blob)) {
    prompt = '帮我校验一下待发布文章的正确性，看看有没有问题。'
    category = 'article'
  } else if (/article.*discover|article-discover|发现项目|扫描项目|可写文章/.test(blob)) {
    prompt = '帮我扫描一下有哪些 github 项目可以写技术文章。'
    category = 'article'
  } else if (/pse.*review|pse-review|资产分析|投资组合.*深度/.test(blob)) {
    prompt = '帮我做一份深度投资组合分析，用 autogen-pse 的 PSE 三角色流水线生成。'
    category = 'invest'
  } else if (/portfolio.*summary|portfolio-summary|资产.*概览|持仓.*汇总/.test(blob)) {
    prompt = '帮我做一份当前投资组合的快速概览，包括持仓、收益和风险分布。'
    category = 'invest'
  } else if (/resume.*tailor|tailor.*resume|resume-tailor|简历/.test(blob)) {
    prompt = '帮我定制一份简历，目标岗位 JD：资深后端工程师，要求 5 年以上 Java/Python 经验，熟悉分布式系统和微服务架构。'
    category = 'interview'
  } else if (/interview.*question|question.*interview|interview-questions|面试题|题库/.test(blob)) {
    prompt = '帮我生成一份 Python 后端工程师的技术面试题库，包含基础、进阶、难题各 3 道。'
    category = 'interview'
  } else if (/crm.*task|crm-task|crm.*qa|follow.*up|weekly.*review|数据质量|跟进|复盘/.test(blob)) {
    prompt = '帮我生成一份本周的 CRM 关系复盘，看看哪些联系人需要跟进。'
    category = 'crm'
  } else if (/code.dir|code_dir/.test(blob)) {
    prompt = `用符号/诊断等语义分析深入理解一个代码目录的结构。`
    category = 'code'
  } else if (/(analy|scan|directory|folder|list.*files|tree)/.test(blob)) {
    prompt = `分析一个目录的结构与关键文件，并总结它做了什么。`
    category = 'code'
  } else if (/(read|cat|load|get_file|view)/.test(blob)) {
    prompt = `读取指定文件的内容，并总结它做了什么。`
    category = 'code'
  } else if (/(write|edit|create|save|update|patch)/.test(blob)) {
    prompt = `帮我在项目里新建或修改一个文件。`
    category = 'code'
  } else if (/(shell|exec|bash|run|terminal|command|cmd)/.test(blob)) {
    prompt = `在终端执行命令并解释它的输出。`
    category = 'code'
  } else if (/(search|grep|find|locate)/.test(blob)) {
    prompt = `在代码库中搜索某段逻辑的定义与用法。`
    category = 'code'
  } else if (/(fetch|http|web|browser|scrap|url|crawl)/.test(blob)) {
    prompt = `抓取一个网页并提取关键信息。`
    category = 'code'
  } else if (/(sql|db|query|database|pg|mysql)/.test(blob)) {
    prompt = `查询数据库并返回结果。`
    category = 'code'
  } else if (/(review|lint|test|check|verify)/.test(blob)) {
    prompt = `对当前改动运行 ${t.name} 检查。`
    category = 'code'
  } else if (/(skill|agent|invoke)/.test(blob)) {
    prompt = `调用 ${t.name} 来完成任务。`
    category = 'other'
  } else {
    return null
  }
  return { id: 'tool:' + t.name, title: humanize(t.name), prompt, category }
}

/**
 * Build example prompts from the runtime's skills and built-in tools, grouped
 * by category. MCP tools are namespaced (e.g. "fs:read") and skipped.
 *
 * Returns categories in display order; empty categories are omitted.
 */
export function buildExamples(
  tools: ToolSchema[],
  skills: SkillInfo[],
): Record<ExampleCategory, ExampleItem[]> {
  const all: ExampleItem[] = []

  for (const s of skills) {
    const e = skillExample(s)
    if (e) all.push(e)
  }

  // Priority tools first so they appear first within each category.
  const priorityTools = [
    'article-write',
    'article-validate',
    'article-publish',
    'article-archive',
    'article-discover',
    'juejin-draft',
    'wechat-draft',
    'sf-pw-publish',
    'pick-post',
    'pse-review',
    'portfolio-summary',
    'resume-tailor',
    'interview-questions',
    'crm-task',
  ]
  for (const name of priorityTools) {
    const tool = tools.find((t) => t.name === name)
    if (tool) {
      const e = toolExample(tool)
      if (e) all.push(e)
    }
  }
  for (const t of tools) {
    if (t.name.includes(':')) continue
    if (priorityTools.includes(t.name)) continue
    const e = toolExample(t)
    if (e) all.push(e)
  }

  // Fixed PSE three-role test prompts — these are designed to show the
  // Planner → Specialist → Evaluator discipline. Only meaningful when the
  // PSE toggle is on, but shown regardless so users can try the contrast.
  const PSE_EXAMPLES: ExampleItem[] = [
    {
      id: 'pse-lru',
      title: 'LRU 缓存（含验收）',
      prompt: '实现一个 Python 的 LRU 缓存类，要求：1) get/put 时间复杂度 O(1)；2) 线程安全；3) 包含单元测试，覆盖正常/边界/并发场景；4) 写一个使用示例。完成后逐条说明每个要求是否满足，不满足的指出问题。',
      category: 'pse',
    },
    {
      id: 'pse-arch',
      title: '项目架构分析',
      prompt: '分析当前项目的架构，输出架构图说明、技术栈选型理由、潜在风险点。每条结论都要有代码证据（引用具体文件和行号），完成后自检证据是否充分。',
      category: 'pse',
    },
    {
      id: 'pse-article',
      title: '技术文章（带自检）',
      prompt: '写一篇关于 RAG 混合检索的技术文章，要求有数据支撑、有代码示例、有对比分析。完成后自检事实准确性，指出文中可能不准确的地方。',
      category: 'pse',
    },
    {
      id: 'pse-debug',
      title: 'Bug 调试与修复',
      prompt: '这段代码有 bug，找出问题根因并修复。修复后说明：1) 根因是什么；2) 修复方案；3) 如何验证修复有效。不要只改代码不解释。',
      category: 'pse',
    },
  ]
  all.push(...PSE_EXAMPLES)

  // Deduplicate by prompt.
  const seen = new Set<string>()
  const uniq = all.filter((e) => {
    if (seen.has(e.prompt)) return false
    seen.add(e.prompt)
    return true
  })

  // Group by category.
  const grouped: Record<ExampleCategory, ExampleItem[]> = {
    article: [],
    invest: [],
    interview: [],
    crm: [],
    pse: [],
    code: [],
    other: [],
  }
  for (const e of uniq) {
    grouped[e.category].push(e)
  }
  return grouped
}

/** Flatten grouped examples back to a flat list (for backward compat / fallback). */
export function flattenExamples(
  grouped: Record<ExampleCategory, ExampleItem[]>,
): ExampleItem[] {
  const out: ExampleItem[] = []
  for (const cat of CATEGORY_ORDER) {
    out.push(...grouped[cat])
  }
  return out
}

/** Shown when no tools/skills are available to derive examples from. */
export const FALLBACK_EXAMPLES: ExampleItem[] = [
  { id: 'fb1', title: '代码审查', prompt: '请对当前改动做一次代码审查，指出风险与改进点。', category: 'code' },
  { id: 'fb2', title: '解释代码', prompt: '请解释某个模块的核心逻辑与数据流。', category: 'code' },
  { id: 'fb3', title: '写测试', prompt: '为指定函数编写单元测试。', category: 'code' },
  { id: 'fb4', title: '生成文档', prompt: '为这个项目生成一份简短的使用说明。', category: 'code' },
  { id: 'fb5', title: '写技术文章', prompt: '帮我写一篇 rag-platform 的技术文章。', category: 'article' },
]
