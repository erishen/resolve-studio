import type { SkillInfo } from './api'
import type { ToolSchema } from './types'

export type ExampleCategory =
  | 'article'
  | 'hot-news'
  | 'invest'
  | 'interview'
  | 'crm'
  | 'pse'
  | 'code'
  | 'library'
  | 'privacy'
  | 'other'

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
  'hot-news': '热点新闻',
  invest: '投资分析',
  interview: '面试求职',
  crm: 'CRM 相关',
  pse: 'PSE 三角色',
  code: '代码工具',
  library: '本地资料库',
  privacy: '隐私自查',
  other: '其他',
}

export const CATEGORY_ORDER: ExampleCategory[] = [
  'article',
  'hot-news',
  'invest',
  'interview',
  'crm',
  'pse',
  'code',
  'library',
  'privacy',
  'other',
]

function humanize(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** 工具/技能 → 中文任务名（示例卡片标题）。未命中的回退英文 humanize。 */
const ZH_TITLES: Record<string, string> = {
  // 文章
  'article-write': '写技术文章',
  'article-validate': '校验文章',
  'article-publish': '发布文章',
  'article-archive': '归档文章',
  'article-discover': '发现可写项目',
  'juejin-draft': '建掘金草稿',
  'wechat-draft': '建公众号草稿',
  'sf-pw-publish': '发布到思否',
  'pick-post': '随机选文章',
  // 投资
  'pse-review': '深度投资复盘',
  'portfolio-check': '投资前数据体检',
  'stock-scan': '全市场技术信号扫描',
  'csv-analyze': 'CSV 数据分析报告',
  'product-analyze': '产品研究',
  // 本地资料库
  'doc-library-search': '文档库检索',
  'photo-duplicates': '照片去重检查',
  'video-library-list': '视频清单',
  // 隐私自查
  'privacy-audit': '隐私泄露审计',
  // 面试 / CRM
  'resume-tailor': '定制简历',
  'interview-questions': '生成面试题库',
  'crm-task': 'CRM 关系复盘',
  // 热点新闻
  'hot-news-fetch': '抓取热点素材',
  'hot-news-topics': '列话题候选',
  'hot-news': '生成热点文案',
  'hot-news-check': '校验热点稿合规',
  'hot-news-publish': '发布热点稿',
  // 技能
  'weekly-investment-review': '周度投资复盘',
  'post-comment': '文章评论',
  'rust-review': 'Rust 代码审查',
  'code-review': '代码审查',
  // 常用内置工具
  'read-file': '读取文件',
  'write-file': '写文件',
  'analyze-dir': '分析目录',
  'analyze-code-dir': '分析代码目录',
  shell: '执行命令',
  browser: '浏览器操作',
  'skill-run': '运行技能',
  echo: '回声测试',
  calculator: '计算器',
  hello: '打招呼',
  'system-info': '系统信息',
}

function titleFor(base: string): string {
  return ZH_TITLES[base] ?? humanize(base)
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
  return { id: 'skill:' + s.name, title: titleFor(s.name), prompt, category }
}

function toolExample(t: ToolSchema): ExampleItem | null {
  // MCP tools are namespaced `<serverId>:<tool>`; strip the prefix so curated
  // examples and the card title match the bare tool name.
  const base = t.name.includes(':') ? t.name.slice(t.name.lastIndexOf(':') + 1) : t.name
  const blob = (t.name + ' ' + (t.description ?? '')).toLowerCase()

  // Curated, name-keyed examples. Match by NAME (not description) to avoid
  // cross-talk — e.g. article-discover's description mentions "article-publish",
  // and "已发布文章" contains the substring "发布文章", both mis-route via the
  // loose description regexes below.
  const CURATED: Record<string, { title: string; prompt: string; category: ExampleCategory }> = {
    'article-write': {
      title: '写技术文章',
      prompt: '帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。',
      category: 'article',
    },
    'article-validate': {
      title: '校验文章',
      prompt: '帮我校验一下待发布文章的正确性，看看有没有问题。',
      category: 'article',
    },
    'article-publish': {
      title: '发布文章',
      prompt:
        '请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。',
      category: 'article',
    },
    'article-archive': {
      title: '归档文章',
      prompt: '帮我归档一篇文章，重建各平台副本并更新关键词索引。',
      category: 'article',
    },
    'article-discover': {
      title: '发现可写项目',
      prompt: '帮我扫描一下有哪些 github 项目可以写技术文章。',
      category: 'article',
    },
    'juejin-draft': {
      title: '建掘金草稿',
      prompt: '帮我把下一篇未发布的文章建成掘金草稿。',
      category: 'article',
    },
    'wechat-draft': {
      title: '建公众号草稿',
      prompt: '帮我把下一篇未发布的文章建成微信公众号草稿箱草稿。',
      category: 'article',
    },
    'sf-pw-publish': {
      title: '发布到思否',
      prompt: '帮我把下一篇未发布的文章发布到思否（用 Playwright 真浏览器）。',
      category: 'article',
    },
    'pick-post': {
      title: '随机选文章',
      prompt:
        '帮我随机挑一篇已发布的文章，只返回标题和链接给我（用 pick-post 工具，只读不评论），我想自己看看内容。',
      category: 'article',
    },
    'pse-review': {
      title: '深度投资复盘',
      prompt: '帮我做一份深度投资组合分析，用 autogen-pse 的 PSE 三角色流水线生成。',
      category: 'invest',
    },
    'portfolio-check': {
      title: '投资前数据体检',
      prompt:
        '帮我做一次投资前数据体检：用 portfolio-check 工具在 analysis-lens 执行 make calculate / analyze / compare 刷新快照并扫描异常，确认数据无误后再做投资复盘。',
      category: 'invest',
    },
    'stock-scan': {
      title: '全市场技术信号扫描',
      prompt:
        '看看今天全市场有哪些值得关注的技术信号，用 stock-scan 工具扫一遍并列出趋势/买入/卖出信号。',
      category: 'invest',
    },
    'csv-analyze': {
      title: 'CSV 数据分析报告',
      prompt: '帮我把这个 CSV 分析一下，用 csv-analyze 工具给我一份带剖视/趋势/异常的报告。',
      category: 'invest',
    },
    'product-analyze': {
      title: '产品研究',
      prompt: '帮我研究一下 Notion AI 这个产品，用 product-analyze 工具做产品与竞品分析。',
      category: 'invest',
    },
    'doc-library-search': {
      title: '文档库检索',
      prompt:
        '在我的 markdown 文档库里搜一下 xxx，用 doc-library-search 工具给我命中的片段和来源路径。',
      category: 'library',
    },
    'photo-duplicates': {
      title: '照片去重检查',
      prompt: '照片库里有没有重复的照片，用 photo-duplicates 工具帮我检查并分组列出。',
      category: 'library',
    },
    'video-library-list': {
      title: '视频清单',
      prompt: '视频库里有哪些视频，用 video-library-list 工具帮我列个清单（编解码/时长/分辨率）。',
      category: 'library',
    },
    'privacy-audit': {
      title: '隐私泄露审计',
      prompt:
        '帮我审计一下当前 repo 有没有隐私泄露，用 privacy-audit 工具跑一遍 9 项检查并报告风险项。',
      category: 'privacy',
    },
    'resume-tailor': {
      title: '定制简历',
      prompt:
        '帮我定制一份简历，目标岗位 JD：资深后端工程师，要求 5 年以上 Java/Python 经验，熟悉分布式系统和微服务架构。',
      category: 'interview',
    },
    'interview-questions': {
      title: '生成面试题库',
      prompt: '帮我生成一份 Python 后端工程师的技术面试题库，包含基础、进阶、难题各 3 道。',
      category: 'interview',
    },
    'crm-task': {
      title: 'CRM 关系复盘',
      prompt: '帮我生成一份本周的 CRM 关系复盘，看看哪些联系人需要跟进。',
      category: 'crm',
    },
    'hot-news-fetch': {
      title: '抓取热点素材',
      prompt:
        '帮我抓取最新的多平台热点新闻作为素材源（微博热搜、量子位、InfoQ 等），用 hot-news-fetch 工具。',
      category: 'hot-news',
    },
    'hot-news-topics': {
      title: '列话题候选',
      prompt:
        '帮我列出当前可写的话题候选（微博热搜+新闻依据，按热度排序），用 hot-news-topics 工具。',
      category: 'hot-news',
    },
    'hot-news': {
      title: '生成热点文案',
      prompt:
        '帮我写一篇小红书热点营销内容，挑最新的 AI 热点话题，用 hot-news 工具生成，品类用 tech_ai。',
      category: 'hot-news',
    },
    'hot-news-check': {
      title: '校验热点稿合规',
      prompt: '帮我校验一篇热点稿是否合规（平台限值+违禁词+AI 声明），用 hot-news-check 工具。',
      category: 'hot-news',
    },
    'skill-run': { title: '运行技能', prompt: `调用 ${t.name} 来完成任务。`, category: 'other' },
  }
  const curated = CURATED[base]
  if (curated)
    return {
      id: 'tool:' + base,
      title: curated.title,
      prompt: curated.prompt,
      category: curated.category,
    }

  let prompt: string
  let category: ExampleCategory = 'code'

  // Hot-news pipeline tools must be routed before the article branches below:
  // their descriptions mention 文章/校验/生成 and would otherwise get mis-typed.
  if (/hot-news|hot_news|热点|热搜/.test(blob)) {
    prompt = '帮我走一遍热点内容流水线：抓最新新闻素材，选话题，生成平台文案并校验合规。'
    category = 'hot-news'
  } else if (/article.*write|write.*article|article-write/.test(blob)) {
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
    prompt =
      '请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。'
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
    prompt =
      '帮我定制一份简历，目标岗位 JD：资深后端工程师，要求 5 年以上 Java/Python 经验，熟悉分布式系统和微服务架构。'
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
  return { id: 'tool:' + base, title: titleFor(base), prompt, category }
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

  // Priority tools first so they appear first within each category. Ordered by
  // each category's natural workflow (e.g. hot-news: fetch → topics → generate
  // → check; article: discover → write → validate → publish → archive).
  const priorityTools = [
    // invest: 数据体检 → 深度复盘 → 信号扫描/CSV/产品
    'portfolio-check',
    'pse-review',
    'stock-scan',
    'csv-analyze',
    'product-analyze',
    // article: 发现项目 → 写作 → 校验 → 发布 WP → 草稿 → 思否 → 归档 → 随机选文
    'article-discover',
    'article-write',
    'article-validate',
    'article-publish',
    'juejin-draft',
    'wechat-draft',
    'sf-pw-publish',
    'article-archive',
    'pick-post',
    // interview: 定制简历 → 面试题库
    'resume-tailor',
    'interview-questions',
    // crm
    'crm-task',
    // hot-news: 抓素材 → 列话题 → 生成 → 校验（发布静态卡在末尾）
    'hot-news-fetch',
    'hot-news-topics',
    'hot-news',
    'hot-news-check',
  ]
  for (const name of priorityTools) {
    // MCP tools register as `<serverId>:<tool>` (mcp.ts); match both the bare
    // name (native tools) and the namespaced form (e.g. `pse-review:pse-review`).
    const tool = tools.find((t) => t.name === name || t.name.endsWith(':' + name))
    if (tool) {
      const e = toolExample(tool)
      if (e) all.push(e)
    }
  }
  for (const t of tools) {
    if (t.name.includes(':')) continue
    if (priorityTools.includes(t.name)) continue
    // 发布示例由上方静态 HOT_NEWS_PUBLISH_EXAMPLES 的三张平台卡覆盖；
    // 跳过工具派生的通用卡，避免与「小红书/知乎/头条发布热点稿」重复。
    if (t.name === 'hot-news-publish') continue
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
      prompt:
        '实现一个 Python 的 LRU 缓存类，要求：1) get/put 时间复杂度 O(1)；2) 线程安全；3) 包含单元测试，覆盖正常/边界/并发场景；4) 写一个使用示例。完成后逐条说明每个要求是否满足，不满足的指出问题。',
      category: 'pse',
    },
    {
      id: 'pse-arch',
      title: '项目架构分析',
      prompt:
        '分析当前项目的架构，输出架构图说明、技术栈选型理由、潜在风险点。每条结论都要有代码证据（引用具体文件和行号），完成后自检证据是否充分。',
      category: 'pse',
    },
    {
      id: 'pse-article',
      title: '技术文章（带自检）',
      prompt:
        '写一篇关于 RAG 混合检索的技术文章，要求有数据支撑、有代码示例、有对比分析。完成后自检事实准确性，指出文中可能不准确的地方。',
      category: 'pse',
    },
    {
      id: 'pse-debug',
      title: 'Bug 调试与修复',
      prompt:
        '这段代码有 bug，找出问题根因并修复。修复后说明：1) 根因是什么；2) 修复方案；3) 如何验证修复有效。不要只改代码不解释。',
      category: 'pse',
    },
  ]
  all.push(...PSE_EXAMPLES)

  // 热点稿发布示例：三个平台各一张卡（hot-news-publish 用 Playwright 真浏览器
  // 填稿后停在编辑器，由人工核对发布，绝不自动发布；需先完成一次平台登录）。
  const HOT_NEWS_PUBLISH_EXAMPLES: ExampleItem[] = [
    {
      id: 'hot-news-publish-xiaohongshu',
      title: '小红书发布热点稿',
      prompt:
        '把最新一篇热点稿发布到小红书，用 hot-news-publish 工具（platform=xiaohongshu），填好标题/正文/多图/话题后停在编辑器，我自己核对并点发布。',
      category: 'hot-news',
    },
    {
      id: 'hot-news-publish-zhihu',
      title: '知乎发布热点稿',
      prompt:
        '把最新一篇热点稿发布到知乎，用 hot-news-publish 工具（platform=zhihu），填好标题/正文/封面/话题并尽力勾选 AI 创作声明后停在编辑器，我自己核对并点发布。',
      category: 'hot-news',
    },
    {
      id: 'hot-news-publish-toutiao',
      title: '头条发布热点稿',
      prompt:
        '把最新一篇热点稿发布到今日头条，用 hot-news-publish 工具（platform=toutiao），填好标题/正文后保持页面打开，我自己核对并点发布。',
      category: 'hot-news',
    },
  ]
  all.push(...HOT_NEWS_PUBLISH_EXAMPLES)

  // 文章运维示例：README 文章回链体检（crewai-pse 的 make check-links 只读校验
  // 全部已发布项目仓库的回链完整性，exit 非 0 = 有缺链；修复走 sync-links）。
  const ARTICLE_OPS_EXAMPLES: ExampleItem[] = [
    {
      id: 'article-check-links',
      title: '校验文章回链',
      prompt:
        '在 ***REMOVED***/***REMOVED*** 目录运行一次 make check-links，校验各项目 README 的 erishen.cn 文章回链是否完整。若全绿（0 issues）：直接报告结论收工，不要执行其他命令。仅当有缺失时：列出具体项目和缺的链接，再运行一次 make sync-links FLAGS=--dry 预览修复动作（不要真正写入）。每条命令最多执行一次，失败或超时不要重复同一条命令，直接把现象报告给我。',
      category: 'article',
    },
  ]
  all.push(...ARTICLE_OPS_EXAMPLES)

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
    'hot-news': [],
    invest: [],
    interview: [],
    crm: [],
    pse: [],
    code: [],
    library: [],
    privacy: [],
    other: [],
  }
  for (const e of uniq) {
    grouped[e.category].push(e)
  }

  // Investment: keep portfolio-check first (it's the pre-flight data check that
  // gates the weekly review), then pse-review, then the rest in build order.
  const investOrder = ['tool:portfolio-check', 'tool:pse-review']
  grouped.invest.sort((a, b) => {
    const ia = investOrder.indexOf(a.id)
    const ib = investOrder.indexOf(b.id)
    // Known invest tools go first (in investOrder order); unknown ones keep
    // their relative order but after the known set.
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return 0
  })

  // Article: known tools follow the workflow order (discover → write → validate
  // → publish → archive → drafts); the "文章评论" skill card moves to the end.
  const articleOrder = [
    'tool:article-discover',
    'tool:article-write',
    'tool:article-validate',
    'tool:article-publish',
    'tool:article-archive',
    'tool:juejin-draft',
    'tool:wechat-draft',
    'tool:sf-pw-publish',
    'tool:pick-post',
  ]
  grouped.article.sort((a, b) => {
    const ia = articleOrder.indexOf(a.id)
    const ib = articleOrder.indexOf(b.id)
    // Known tools go first (in articleOrder order); unknown ones (e.g. the
    // "文章评论" skill card) keep relative order but after the known set.
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return 0
  })
  return grouped
}

/** Flatten grouped examples back to a flat list (for backward compat / fallback). */
export function flattenExamples(grouped: Record<ExampleCategory, ExampleItem[]>): ExampleItem[] {
  const out: ExampleItem[] = []
  for (const cat of CATEGORY_ORDER) {
    out.push(...grouped[cat])
  }
  return out
}

/** Shown when no tools/skills are available to derive examples from. */
export const FALLBACK_EXAMPLES: ExampleItem[] = [
  {
    id: 'fb1',
    title: '代码审查',
    prompt: '请对当前改动做一次代码审查，指出风险与改进点。',
    category: 'code',
  },
  { id: 'fb2', title: '解释代码', prompt: '请解释某个模块的核心逻辑与数据流。', category: 'code' },
  { id: 'fb3', title: '写测试', prompt: '为指定函数编写单元测试。', category: 'code' },
  { id: 'fb4', title: '生成文档', prompt: '为这个项目生成一份简短的使用说明。', category: 'code' },
  {
    id: 'fb5',
    title: '写技术文章',
    prompt: '帮我写一篇 rag-platform 的技术文章。',
    category: 'article',
  },
]

/**
 * 流水线任务的「下一步」示例：已完成工具名 → 可选的后续示例任务。
 * 供 MessageList 在任务完成后展示，点击即填入提示词继续。
 */
export const NEXT_STEP_EXAMPLES: Record<string, ExampleItem[]> = {
  // hot-news 流水线：抓素材 → 列话题 → 生成 → 校验 → 发布
  'hot-news-fetch': [
    {
      id: 'next-hot-news-topics',
      title: '列话题候选',
      prompt:
        '帮我列出当前可写的话题候选（微博热搜+新闻依据，按热度排序），用 hot-news-topics 工具。',
      category: 'hot-news',
    },
  ],
  'hot-news-topics': [
    {
      id: 'next-hot-news-generate',
      title: '生成热点文案',
      prompt:
        '帮我写一篇小红书热点营销内容，挑最新的 AI 热点话题，用 hot-news 工具生成，品类用 tech_ai。',
      category: 'hot-news',
    },
  ],
  'hot-news': [
    {
      id: 'next-hot-news-check',
      title: '校验热点稿合规',
      prompt: '帮我校验一篇热点稿是否合规（平台限值+违禁词+AI 声明），用 hot-news-check 工具。',
      category: 'hot-news',
    },
  ],
  'hot-news-check': [
    {
      id: 'next-hot-news-publish-xhs',
      title: '小红书发布热点稿',
      prompt:
        '把最新一篇热点稿发布到小红书，用 hot-news-publish 工具（platform=xiaohongshu），填好标题/正文/多图/话题后停在编辑器，我自己核对并点发布。',
      category: 'hot-news',
    },
    {
      id: 'next-hot-news-publish-zhihu',
      title: '知乎发布热点稿',
      prompt:
        '把最新一篇热点稿发布到知乎，用 hot-news-publish 工具（platform=zhihu），填好标题/正文/封面/话题并尽力勾选 AI 创作声明后停在编辑器，我自己核对并点发布。',
      category: 'hot-news',
    },
    {
      id: 'next-hot-news-publish-toutiao',
      title: '头条发布热点稿',
      prompt:
        '把最新一篇热点稿发布到今日头条，用 hot-news-publish 工具（platform=toutiao），填好标题/正文后保持页面打开，我自己核对并点发布。',
      category: 'hot-news',
    },
  ],
  // article 流水线：发现项目 → 写作 → 校验 → 发布 → 归档
  'article-discover': [
    {
      id: 'next-article-write',
      title: '写技术文章',
      prompt: '帮我写一篇技术文章，用 crewai-pse 三角色流水线生成。',
      category: 'article',
    },
  ],
  'article-write': [
    {
      id: 'next-article-validate',
      title: '校验文章',
      prompt: '帮我校验一下待发布文章的正确性，看看有没有问题。',
      category: 'article',
    },
  ],
  'article-validate': [
    {
      id: 'next-article-publish',
      title: '发布文章',
      prompt:
        '请调用 article-publish 工具（不要传 project、也不要设 confirm）列出当前待发布到 WordPress 的文章清单供我选择。',
      category: 'article',
    },
  ],
  'article-publish': [
    {
      id: 'next-article-archive',
      title: '归档文章',
      prompt: '帮我归档一篇文章，重建各平台副本并更新关键词索引。',
      category: 'article',
    },
  ],
  // invest：数据体检 → 深度复盘
  'portfolio-check': [
    {
      id: 'next-pse-review',
      title: '深度投资复盘',
      prompt: '帮我做一份深度投资组合分析，用 autogen-pse 的 PSE 三角色流水线生成。',
      category: 'invest',
    },
  ],
}
