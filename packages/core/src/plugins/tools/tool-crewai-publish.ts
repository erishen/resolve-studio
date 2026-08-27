import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
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

async function loadProjectKeys(): Promise<string[]> {
  try {
    const raw = await readFile(PROJECTS_FILE, { encoding: 'utf8' })
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
      'The project MUST be one from the enum. If the user did not specify a project, call this tool WITHOUT the project parameter first to get the list of available projects — do NOT guess or invent a project name.',
  },
  {
    name: 'article-publish',
    label: '发布文章',
    makeTarget: 'publish',
    script: PUBLISH,
    preValidate: true,
    description:
      '发布已生成的文章到 WordPress。发布前自动运行 article-validate 校验，有错误则阻止发布并提示修复。调用 crewai-pse 的 `make publish P=<project>`，把待发布队列中的文章发布到线上并写回 wp_id/link。需要 .env 中的 WordPress 凭据。 ' +
      'The project MUST be one from the enum. If the user did not specify a project, call this tool WITHOUT the project parameter first to get the list of available projects — do NOT guess or invent a project name.',
  },
  {
    name: 'article-archive',
    label: '归档文章',
    makeTarget: 'archive',
    script: ARCHIVE,
    description:
      '归档文章到 wordpress-tools 并重建各平台副本。调用 crewai-pse 的 `make archive P=<project>`，把已发布文章归档、重建 juejin/segmentfault/wechat 草稿副本、更新关键词索引、清理源码镜像缓存。 ' +
      'The project MUST be one from the enum. If the user did not specify a project, call this tool WITHOUT the project parameter first to get the list of available projects — do NOT guess or invent a project name.',
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
            'Project key from crewai-pse projects.json. OMIT this parameter to get the list of available projects (when user has not specified one).',
          enum: projectKeys.length ? projectKeys : undefined,
        },
      },
      required: [],
    },
    async execute(
      args: { project?: string },
      execCtx?: ToolExecutionContext,
    ): Promise<string> {
      const { project } = args
      const onProgress = execCtx?.onProgress

      // If no project specified, return the list of available projects.
      if (!project) {
        if (projectKeys.length === 0) {
          return 'error: no projects configured in crewai-pse projects.json.'
        }
        return (
          `可用的${task.label}项目（请选择一个）：\n` +
          projectKeys.map((k, i) => `${i + 1}. ${k}`).join('\n') +
          `\n\n请告诉我你想${task.label}哪个项目。`
        )
      }

      // Validate project against known keys (best-effort).
      if (projectKeys.length > 0 && !projectKeys.includes(project)) {
        return `error: unknown project "${project}". Available: ${projectKeys.join(', ')}`
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
  let projectKeys: string[] = []
  loadProjectKeys().then((keys) => {
    projectKeys = keys
  })

  for (const task of TASKS) {
    registerTask(ctx, task, projectKeys)
  }
  ctx.logger('crewai-publish').info('registered %d crewai-pse publish tasks: %s', TASKS.length, TASKS.map((t) => t.name).join(', '))
}

export const toolCrewAiPublish = definePlugin(registerCrewAiPublish, 'tool-crewai-publish', ['tools'])
