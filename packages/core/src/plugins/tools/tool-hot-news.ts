import { join } from 'node:path'
import { readdir, readFile, access } from 'node:fs/promises'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { runPseTask, resolveTaskDir, gateNonFreeProvider } from './util-pse.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

// Hot-news content generation is a PSE pipeline (Planner + Specialist +
// Evaluator + Verify) with RAG grounding (news as source) + deterministic
// compliance verify_fn. runPseTask owns the run.py guard and uv spawn.

// llamaindex-pse provider set (NOT the free/deepseek of langgraph-pse).
// These strings are a cross-process contract: they are passed through as
// `--provider=<value>` and matched by `llamaindex_pse.model.resolve_provider`
// in the Python framework, and they also form the output filename
// (`hot_news_<platform>_<provider>.md`). Never rename them here alone — a
// rename has to land in the framework and this tool in the same commit.
// DEFAULT_PROVIDER is the operator's configured default gateway (the free
// channel), so it must stay in sync with the framework's own default.
const PROVIDERS = ['deepseek', 'free', 'scnet-kimi', 'scnet-minimax'] as const
type Provider = (typeof PROVIDERS)[number]
const DEFAULT_PROVIDER: Provider = 'free'

// hot-news is the heaviest PSE pipeline (RAG index build + Planner/Specialist/
// Evaluator/Verify + per-round compliance verify_fn), so it needs a much larger
// budget than the generic 5-min DEFAULT_RUN_TIMEOUT_MS — otherwise long runs
// get SIGTERMed (exit 143) mid-flight. Match hot-news-publish's 15 min.
const RUN_TIMEOUT_MS = 900_000

// hot-news-fetch 落盘的快照目录：不传 news_dir 时默认用它做 RAG grounding 源，
// 避免模型漏传 news_dir 导致纯 topic 无事实对照（甚至触发 run.py 崩溃）。
const hotNewsDir = () => resolveTaskDir('llamaindex', 'hot-news')
const newsDir = () => join(hotNewsDir(), 'news')

const PLATFORMS = ['xiaohongshu', 'douyin', 'zhihu', 'toutiao'] as const
type Platform = (typeof PLATFORMS)[number]

const CATEGORIES = [
  'tech_ai',
  'beauty',
  'food',
  'education',
  'finance',
  'medical',
  'ecommerce',
] as const
type Category = (typeof CATEGORIES)[number]

export interface HotNewsConfig {
  _placeholder?: never
}

const registerHotNews = (ctx: Context, _config: HotNewsConfig = {}) => {
  ctx.tools.register({
    name: 'hot-news',
    description:
      'Run the llamaindex-pse hot-news pipeline (Planner + Specialist + Evaluator + Verify) ' +
      'to generate compliant social-media copy for a hot topic. ' +
      'The pipeline builds a RAG index over the provided news directory (grounding source) ' +
      'so the copy is fact-anchored, then runs a deterministic compliance verify_fn every round ' +
      '(banned words by category / platform format limits / mandatory "AI 辅助创作" label / ' +
      'factual-claim-vs-news cross-check). Semantic edge cases go to the LLM evaluator (first round only). ' +
      'Supports Xiaohongshu / Douyin / Zhihu / Toutiao, and categories tech_ai (default, most lenient) ' +
      'through finance/medical (strictest). Returns the generated Markdown copy and save path. ' +
      'Use when the user asks to draft a Xiaohongshu/Douyin post about a trending topic. ' +
      'Default provider: the gateway configured in the PSE framework (free, no approval). ' +
      'Any explicitly chosen non-default provider (deepseek / scnet-kimi / scnet-minimax) is PAID and triggers a human ' +
      'approval prompt — wait for the user to approve before assuming it will run; if rejected, ' +
      'do NOT retry with a paid provider. ' +
      'Do NOT read any files before calling this tool — all paths and configs are handled internally.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: '热点主题（必填），如「AI 生成内容新规落地」。',
        },
        news_dir: {
          type: 'string',
          description:
            '已抓取新闻目录的绝对路径（RAG grounding 源）。不传时默认使用 hot-news-fetch 的快照目录 ' +
            '（tasks/hot-news/news）；仅当该目录也不存在时才降级为纯 topic 生成（无事实对照）。',
        },
        platform: {
          type: 'string',
          description: '目标发布平台。',
          enum: [...PLATFORMS],
          default: 'xiaohongshu',
        },
        category: {
          type: 'string',
          description: '内容品类，决定违禁词表松紧（tech_ai 最宽松；finance/medical 最严）。',
          enum: [...CATEGORIES],
          default: 'tech_ai',
        },
        provider: {
          type: 'string',
          description:
            'LLM 网关。不传则使用 PSE 框架配置的默认网关（免费，无需审批）；' +
            '显式指定 deepseek / scnet-kimi / scnet-minimax 为付费网关，需人工审批。',
          enum: [...PROVIDERS],
          default: DEFAULT_PROVIDER,
        },
      },
      required: ['topic'],
    },
    // Omitting `provider` (framework default) is free; any explicit
    // non-default provider is paid and requires approval.
    approvalWhen: gateNonFreeProvider(DEFAULT_PROVIDER),
    async execute(
      args: {
        topic: string
        news_dir?: string
        platform?: Platform
        category?: Category
        provider?: Provider
      },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const {
        topic,
        news_dir,
        platform = 'xiaohongshu',
        category = 'tech_ai',
        provider = DEFAULT_PROVIDER,
      } = args
      const onProgress = execCtx?.onProgress

      if (!topic?.trim()) {
        return 'error: hot-news requires a non-empty topic.'
      }

      // 默认用 hot-news-fetch 的快照目录做 grounding；快照缺失时才降级纯 topic。
      let newsDirFlag = ''
      if (news_dir?.trim()) {
        newsDirFlag = `--news-dir=${news_dir.trim()}`
      } else {
        try {
          await access(newsDir())
          newsDirFlag = `--news-dir=${newsDir()}`
        } catch {
          newsDirFlag = ''
        }
      }

      // runPseTask prepends `uv run python <run.py>` and owns the run.py guard.
      const cmdArgs = [
        `--topic=${topic}`,
        `--platform=${platform}`,
        `--category=${category}`,
        `--provider=${provider}`,
      ]
      if (newsDirFlag) {
        cmdArgs.push(newsDirFlag)
      }

      const res = await runPseTask({
        tool: 'hot-news',
        framework: 'llamaindex',
        task: 'hot-news',
        args: cmdArgs,
        timeoutMs: RUN_TIMEOUT_MS,
        onProgress,
        logger: (msg, ...a) => ctx.logger('hot-news').info(msg, ...a),
      })
      if (!res.ok) return res.error

      const { stdout, taskDir } = res

      // Output file naming matches run.py: hot_news_<platform>_<provider>.md,
      // written to the task's articles/ dir (default --out-dir) with a
      // timestamp suffix; fall back to the task root for safety.
      let outputContent = ''
      let outputPath = ''
      for (const dir of [join(taskDir, 'articles'), taskDir]) {
        try {
          const files = (await readdir(dir)).filter(
            (f) => f.startsWith(`hot_news_${platform}_${provider}`) && f.endsWith('.md'),
          )
          if (files.length) {
            const picked = files.sort().reverse()[0]!
            outputPath = join(dir, picked)
            outputContent = await readFile(outputPath, 'utf8')
            break
          }
        } catch {
          // dir missing / unreadable → try the next candidate
        }
      }

      const result = [
        `> hot-news 完成（平台：${platform}，品类：${category}，模型：${provider}）`,
        newsDirFlag
          ? `> 新闻源：${newsDirFlag.replace('--news-dir=', '')}`
          : '> 注意：新闻快照目录不存在，纯主题降级生成（无事实对照）',
        outputPath ? `> 输出文件：${outputPath}` : '> 注意：未找到输出文件',
        '',
      ]

      if (outputContent) {
        result.push('--- 生成内容（已完整读取，无需再调用 fs:read_text_file）---')
        result.push(outputContent)
      } else {
        result.push('> 流水线输出：')
        result.push(stdout.slice(-1500))
      }

      return result.join('\n')
    },
  } as Tool)
}

export const toolHotNews = definePlugin(registerHotNews, 'tool-hot-news', ['tools'])
