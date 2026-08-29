import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

const execFileAsync = promisify(execFile)

// …/resolve-studio/packages/core/src/plugins/tools →
// 8 levels up = ***REMOVED***. Override with CREWAI_PSE_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const CREWAI_PSE =
  process.env.CREWAI_PSE_DIR ?? resolve(HERE, '***REMOVED******REMOVED***')

const PUBLISH = join('tasks', 'project-articles', 'publish.py')
const ARCHIVE = join('tasks', 'project-articles', 'archive.py')
const VALIDATE = join('tasks', 'project-articles', 'validate.py')

// Publishing may hit WordPress API + rebuild platform copies — give it time.
const TASK_TIMEOUT_MS = 300_000
const MAX_OUTPUT = 32 * 1024

// Pending queue (projects.json) — articles not yet published.
const PROJECTS_FILE = join(CREWAI_PSE, 'tasks', 'project-articles', 'projects.json')

// Generated articles live here (including already-published ones like
// resolve-tui that remain as files but are absent from the pending queue).
const PSE_ARTICLES_DIR = join(
  CREWAI_PSE,
  '..',
  '..',
  'personal',
  'personal-site',
  'wordpress-tools',
  'articles',
  'pse',
  'zh',
)

function loadJsonKeys(file: string): string[] {
  try {
    const raw = readFileSync(file, 'utf8')
    return Object.keys(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return []
  }
}

// Project enum = union of the pending queue (projects.json) and the generated
// articles directory. Pending projects with not-yet-generated articles stay
// listed; already-published articles still present as files stay publishable.
// projects-published.json is deliberately NOT read here.
function loadArticleKeys(): string[] {
  const keys = new Set<string>(loadJsonKeys(PROJECTS_FILE))
  try {
    for (const name of readdirSync(PSE_ARTICLES_DIR)) {
      const m = /^(.+?)-zh\.md$/.exec(name)
      if (!m) continue
      const slug = m[1]
      // 下划线 slug（resolve_tui）→ 连字符 project key（resolve-tui）
      keys.add(slug.replace(/_/g, '-'))
    }
  } catch {
    // 目录不存在/不可读：仅用 json 队列
  }
  return [...keys].sort()
}

interface CrewAiPublishTaskDef {
  name: string
  label: string
  makeTarget: string
  script: string
  description: string
  /** If true, run `make validate` first and block on errors. */
  preValidate?: boolean
}

const TASKS: CrewAiPublishTaskDef[] = [
  {
    name: 'article-validate',
    label: '校验文章',
    makeTarget: 'validate',
    script: VALIDATE,
    description:
      '发布前校验文章正确性。检查 articles/pse/zh 和 en 下的文章：文件存在性、frontmatter 完整性（title/date/slug/categories/tags/description/excerpt）、正文有效性（长度/标题数/非计划口吻）、思维链泄漏检测、FAQ 区块存在性与中英文数量一致、slug 命名规范、代码块闭合、日期格式。返回通过/错误/警告清单。 ' +
      'The project MUST be one from the `project` enum (read it from the tool schema — do NOT call this tool to discover choices). If the user did not specify a project, ASK the user to pick one of the enum values, then call with `project` set. Never guess or invent a project name. 不传 project 会列出待校验队列清单。',
  },
  {
    name: 'article-publish',
    label: '发布文章',
    makeTarget: 'publish',
    script: PUBLISH,
    preValidate: true,
    description:
      '发布已生成的文章到 WordPress。发布前自动运行 article-validate 校验，有错误则阻止发布并提示修复。调用 crewai-pse 的 `make publish P=<project>`，把待发布队列中的文章发布到线上并写回 wp_id/link。需要 .env 中的 WordPress 凭据。' +
      '⚠️ 这是【发布】工具：调用时不传 project 会列出当前待发布队列中的所有文章供用户选择，用户选定后再带 project 调用即可发布；不要改用 article-discover（那是用于发现【新】项目以撰写文章，不负责发布）。 ' +
      'The project MUST be one from the `project` enum (read it from the tool schema — do NOT call this tool to discover choices). If the user did not specify a project, ASK the user to pick one of the enum values, then call with `project` set. Never guess or invent a project name. This parameter is REQUIRED.' +
      '🛑 安全闸门：本工具默认【只预览、不真正发布】。只有 `confirm` 参数显式设为 true 时才会 POST 到 WordPress。且一次只能发布用户【明确点名】的那一篇 project——绝对禁止对队列里的多篇文章循环调用本工具、或在一次回复里批量发布。未等用户明确指定 project 前，不要设 confirm=true。若用户只泛泛地说「发布一篇文章」却没给出具体 project，你必须先停下来问清楚要发布哪一篇，绝不可自行从清单里挑一个并设 confirm=true。',
   },
  {
    name: 'article-archive',
    label: '归档文章',
    makeTarget: 'archive',
    script: ARCHIVE,
    description:
      '归档已发布文章到 wordpress-tools 并重建各平台副本。调用 crewai-pse 的 `make archive P=<project>`，把已发布文章归档、重建 juejin/segmentfault/wechat 草稿副本、更新关键词索引、清理源码镜像缓存。注意：归档 ≠ 发布——本工具不 POST 到 WordPress，只整理本地/平台副本。' +
      '⚠️ 这是【归档】工具：调用时不传 project 会列出当前可归档队列中的所有文章供用户选择，用户选定后再带 project 调用即可归档；不要改用 article-discover（那是用于发现【新】项目以撰写文章，不负责归档）。 ' +
      'The project MUST be one from the `project` enum (read it from the tool schema — do NOT call this tool to discover choices). If the user did not specify a project, ASK the user to pick one of the enum values, then call with `project` set. Never guess or invent a project name.' +
      '🛑 安全闸门：本工具默认【只预览、不真正归档】。只有 `confirm` 参数显式设为 true 时才会执行 `make archive`。且一次只能归档用户【明确点名】的那一篇 project——绝对禁止对队列里的多篇文章循环调用本工具、或在一次回复里批量归档。未等用户明确指定 project 前，不要设 confirm=true。若用户只泛泛地说「归档一篇文章」却没给出具体 project，你必须先停下来问清楚要归档哪一篇，绝不可自行从清单里挑一个并设 confirm=true。',
  },
]

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

function registerTask(ctx: Context, task: CrewAiPublishTaskDef, projectKeys: string[]) {
  ctx.tools.register({
    name: task.name,
    description: task.description,
    parameters: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description:
            'Project key from crewai-pse projects.json。不传 project 会列出待处理队列清单供用户选择；用户指定后传 project=<key 或 编号>。',
          enum: projectKeys.length ? projectKeys : undefined,
        },
        confirm: {
          type: 'boolean',
          description:
            '安全闸门。必须显式设为 true 才会真正 POST 到 WordPress；缺省或 false 只做只读预览（跑校验、打印将执行的操作，但不发布）。仅在用户已明确点名这篇 project 后才可设 true；禁止对同一队列批量设 true。',
          default: false,
        },
      },
      required: [],
    },
    async execute(
      args: { project?: string; confirm?: boolean },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { project: rawProject, confirm } = args
      const onProgress = execCtx?.onProgress

      // Allow numeric index selection (1-based) from the enumerated list, so a
      // user/agent reply like "4" maps to projectKeys[3] instead of failing.
      let project = rawProject
      if (project && /^\d+$/.test(project.trim())) {
        const idx = parseInt(project.trim(), 10) - 1
        if (idx >= 0 && idx < projectKeys.length) project = projectKeys[idx]
        else return `error: 编号 ${project} 超出范围（1-${projectKeys.length}）`
      }

      // If no project specified (shouldn't happen — `project` is required), ask
      // the user to choose instead of re-listing in a loop.
      if (!project) {
        if (projectKeys.length === 0) {
          return 'error: no projects configured in crewai-pse projects.json.'
        }
        return (
          `(清单模式：未指定 project) 可用项目见本工具的 project 枚举（crewai-pse projects.json 的 key），也可直接传列表中的编号：\n` +
          projectKeys.map((k, i) => `${i + 1}. ${k}`).join('\n') +
          `\n\n要预览并执行某篇，请再次调用本工具并带 \`project=<项目名 或 编号>\`（如 project="resolve-studio" 或 project="4"）；本工具默认只预览不执行，确认执行需另带 confirm=true。`
        )
      }

      // Validate project against known keys (best-effort).
      if (projectKeys.length > 0 && !projectKeys.includes(project)) {
        return `error: unknown project "${project}". Available: ${projectKeys.join(', ')}`
      }

      // Enforce one article per call: reject comma/space-separated multi-project.
      if (/[,\s]/.test(project)) {
        return `error: ${task.name} 每次只能处理一篇文章（一个 project）。收到 "${project}" 疑似含多个项目；请只传单个 project，需要多篇时分别调用本工具。`
      }

      // Preview gate: without explicit confirm=true, NEVER POST. Run the
      // read-only validate so the user sees readiness, then return a preview.
      if (confirm !== true) {
        ctx.logger(task.name).info('preview mode (confirm=false): P=%s', project)
        let validated = false
        if (task.preValidate) {
          onProgress?.('🔍 预览：先跑发布前校验（只读，不发布）...\n')
          try {
            const v = await execFileAsync('make', ['validate', `P=${project}`], {
              cwd: CREWAI_PSE,
              timeout: 60_000,
              maxBuffer: 4 << 20,
            })
            onProgress?.((v.stdout || '') + (v.stderr ? '\n' + v.stderr : ''))
            validated = true
          } catch (verr) {
            const ve = verr as { stdout?: string; stderr?: string; code?: number }
            const vtail = (ve.stdout || '') + (ve.stderr ? '\n--- stderr ---\n' + ve.stderr : '')
            return (
              `⚠️ 预览中止：article-validate 未通过（exit ${ve.code ?? 'unknown'}），执行会被拦截。请先修复后再带 confirm=true 调用。\n\n` +
              truncate(vtail, 4000)
            )
          }
        }
        const ready = validated
          ? '，且发布前校验已通过（文章文件存在、frontmatter 完整）'
          : ''
        return (
          `👁️ 预览模式（未真正执行，仅展示将执行的操作）${ready}：\n` +
          `📋 project=${project} 已在队列中，可${task.label}。\n` +
          `📤 确认后将执行 \`make ${task.makeTarget} P=${project}\`（${task.label}）。\n` +
          `👉 请让用户确认；用户确认后再次调用本工具并带 \`confirm=true\`（只针对这一篇 project）即真正执行。`
        )
      }

      // Pre-publish validation gate: run `make validate` first; block on errors.
      if (task.preValidate) {
        ctx.logger(task.name).info('pre-validate: make validate P=%s', project)
        onProgress?.('🔍 发布前校验中...\n')
        try {
          const v = await execFileAsync('make', ['validate', `P=${project}`], {
            cwd: CREWAI_PSE,
            timeout: 60_000,
            maxBuffer: 4 << 20,
          })
          const vout = (v.stdout || '') + (v.stderr ? '\n' + v.stderr : '')
          onProgress?.(vout)
          // exit 0 = passed (warnings allowed); non-zero = errors → block
        } catch (verr) {
          const ve = verr as { stdout?: string; stderr?: string; code?: number }
          const vtail = (ve.stdout || '') + (ve.stderr ? '\n' + ve.stderr : '')
          return (
            `⛔ 执行已拦截：article-validate 未通过（exit ${ve.code ?? 'unknown'}），请先修复以下问题：\n\n` +
            truncate(vtail, 4000) +
            `\n\n修复后可重新调用 ${task.name}，或先用 article-validate 单独复查。`
          )
        }
        onProgress?.('✅ 校验通过，开始发布...\n\n')
      }

      ctx.logger(task.name).info('running make %s P=%s (cwd=%s)', task.makeTarget, project, CREWAI_PSE)

      try {
        const { stdout, stderr } = await execFileAsync(
          'make',
          [task.makeTarget, `P=${project}`],
          {
            cwd: CREWAI_PSE,
            timeout: TASK_TIMEOUT_MS,
            maxBuffer: 4 << 20,
          },
        )
        const combined = (stdout || '') + (stderr ? '\n--- stderr ---\n' + stderr : '')
        onProgress?.(combined)
        return `> ${task.label}完成 (make ${task.makeTarget} P=${project})\n\n` + truncate(combined, MAX_OUTPUT)
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string; code?: number }
        const tail = (e.stdout || '') + (e.stderr ? '\n--- stderr ---\n' + e.stderr : '') || e.message || String(err)
        return `error: ${task.name} failed (exit ${e.code ?? 'unknown'}) — ${truncate(tail, 2000)}`
      }
    },
  } satisfies Tool)
}

const registerCrewAiPublish = (ctx: Context) => {
  const articleKeys = loadArticleKeys()

  for (const task of TASKS) {
    // 所有任务（publish/validate/archive）共用「目录文章 + json 存档」的并集：
    // 已发布但尚未归档的文章（如 resolve-tui）也能从 UI 重新发布/校验/归档。
    registerTask(ctx, task, articleKeys)
  }
  ctx.logger('crewai-publish').info('registered %d crewai-pse publish tasks: %s', TASKS.length, TASKS.map((t) => t.name).join(', '))
}

export const toolCrewAiPublish = definePlugin(registerCrewAiPublish, 'tool-crewai-publish', ['tools'])
