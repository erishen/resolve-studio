import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
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

// Project keys are read from projects.json at registration time.
const PROJECTS_FILE = join(CREWAI_PSE, 'tasks', 'project-articles', 'projects.json')

// Loaded synchronously at module-eval so the `project` enum is populated in the
// tool schema at registration time. (An async load would leave the enum empty,
// hiding the choices from the model and causing repeated no-project calls.)
function loadProjectKeys(): string[] {
  try {
    const raw = readFileSync(PROJECTS_FILE, 'utf8')
    const obj = JSON.parse(raw) as Record<string, unknown>
    return Object.keys(obj).sort()
  } catch {
    return []
  }
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
      'The project MUST be one from the `project` enum (read it from the tool schema — do NOT call this tool to discover choices). If the user did not specify a project, ASK the user to pick one of the enum values, then call with `project` set. Never guess or invent a project name. This parameter is REQUIRED.',
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
      '🛑 安全闸门：本工具默认【只预览、不真正发布】。只有 `confirm` 参数显式设为 true 时才会 POST 到 WordPress。且一次只能发布用户【明确点名】的那一篇 project——绝对禁止对队列里的多篇文章循环调用本工具、或在一次回复里批量发布。未等用户明确指定 project 前，不要设 confirm=true。',
   },
  {
    name: 'article-archive',
    label: '归档文章',
    makeTarget: 'archive',
    script: ARCHIVE,
    description:
      '归档文章到 wordpress-tools 并重建各平台副本。调用 crewai-pse 的 `make archive P=<project>`，把已发布文章归档、重建 juejin/segmentfault/wechat 草稿副本、更新关键词索引、清理源码镜像缓存。 ' +
      'The project MUST be one from the `project` enum (read it from the tool schema — do NOT call this tool to discover choices). If the user did not specify a project, ASK the user to pick one of the enum values, then call with `project` set. Never guess or invent a project name. This parameter is REQUIRED.',
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
            'Project key from crewai-pse projects.json. This parameter is REQUIRED — pick one of the enum values. If the user has not specified a project, ask them to choose, then pass project=<key>.',
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
          `\n\n要预览/发布某篇，请再次调用本工具并带 \`project=<项目名 或 编号>\`（如 project="resolve-studio" 或 project="4"）；本工具默认只预览不发布，确认发布需另带 confirm=true。`
        )
      }

      // Validate project against known keys (best-effort).
      if (projectKeys.length > 0 && !projectKeys.includes(project)) {
        return `error: unknown project "${project}". Available: ${projectKeys.join(', ')}`
      }

      // Enforce one article per call: reject comma/space-separated multi-project.
      if (/[,\s]/.test(project)) {
        return `error: article-publish 每次只能发布一篇文章（一个 project）。收到 "${project}" 疑似含多个项目；请只传单个 project，需要发多篇时分别调用本工具。`
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
              `⚠️ 预览中止：article-validate 未通过（exit ${ve.code ?? 'unknown'}），发布会被拦截。请先修复后再带 confirm=true 调用。\n\n` +
              truncate(vtail, 4000)
            )
          }
        }
        const ready = validated
          ? '，且发布前校验已通过（文章文件存在、frontmatter 完整）'
          : ''
        return (
          `👁️ 预览模式（未真正发布，仅展示将执行的操作）${ready}：\n` +
          `📋 project=${project} 在可发布项目列表中，待发布文章就绪。\n` +
          `📤 确认发布将执行 \`make ${task.makeTarget} P=${project}\`，把文章发布到 WordPress 并写回 wp_id/link。\n` +
          `👉 请让用户确认；用户确认后再次调用本工具并带 \`confirm=true\`（只针对这一篇 project）即真正发布。`
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
            `⛔ 发布已拦截：article-validate 未通过（exit ${ve.code ?? 'unknown'}），请先修复以下问题：\n\n` +
            truncate(vtail, 4000) +
            '\n\n修复后可重新调用 article-publish，或先用 article-validate 单独复查。'
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
  const projectKeys = loadProjectKeys()

  for (const task of TASKS) {
    registerTask(ctx, task, projectKeys)
  }
  ctx.logger('crewai-publish').info('registered %d crewai-pse publish tasks: %s', TASKS.length, TASKS.map((t) => t.name).join(', '))
}

export const toolCrewAiPublish = definePlugin(registerCrewAiPublish, 'tool-crewai-publish', ['tools'])
