import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'

const execFileAsync = promisify(execFile)

// WP tools live outside this repo (wordpress-tools). Require WORDPRESS_TOOLS_DIR
// from .env so no personal filesystem path leaks into the source.
const WP_TOOLS = process.env.WORDPRESS_TOOLS_DIR

// These tasks may launch a browser (sf-pw-publish) or hit external APIs
// (juejin/wechat). Give them generous timeouts.
const TASK_TIMEOUT_MS = 300_000
const MAX_OUTPUT = 32 * 1024

interface WpTaskDef {
  name: string
  label: string
  makeTarget: string
  description: string
}

const TASKS: WpTaskDef[] = [
  {
    name: 'juejin-draft',
    label: '掘金草稿',
    makeTarget: 'juejin-draft',
    description:
      '建掘金草稿：调用 wordpress-tools 的 `make juejin-draft`，为下一篇未发布文章创建掘金草稿并写回 juejin_draft_id。每次只处理一篇。需要 wordpress-tools/.env 中的掘金 cookie。',
  },
  {
    name: 'wechat-draft',
    label: '微信草稿',
    makeTarget: 'wechat-draft',
    description:
      '建微信公众号草稿：调用 wordpress-tools 的 `make wechat-draft`，为下一篇未发布文章创建公众号草稿箱草稿并写回 wechat_draft_id。每次只处理一篇。必须在本机 Mac 运行（微信校验 IP），需要 .env 中的 appid/appsecret。',
  },
  {
    name: 'sf-pw-publish',
    label: '思否发布',
    makeTarget: 'sf-pw-publish',
    description:
      '思否发布（Playwright 真浏览器版）：调用 wordpress-tools 的 `make sf-pw-publish`，启动浏览器登录思否并发布下一篇未发布文章，写回 sf_id。每次只发一篇。需要 Chrome 已登录思否（或设置 SF_USER_DATA_DIR）。',
  },
]

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

function registerWpTask(ctx: Context, task: WpTaskDef) {
  ctx.tools.register({
    name: task.name,
    description: task.description,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    async execute(_args: Record<string, never>, execCtx?: ToolExecutionContext): Promise<string> {
      if (!WP_TOOLS) {
        return `error: ${task.name} 不可用 — WORDPRESS_TOOLS_DIR 未设置，请在 .env 中配置 wordpress-tools 的路径。`
      }
      const onProgress = execCtx?.onProgress

      ctx.logger(task.name).info('running make %s (cwd=%s)', task.makeTarget, WP_TOOLS)

      try {
        const { stdout, stderr } = await execFileAsync('make', [task.makeTarget], {
          cwd: WP_TOOLS,
          timeout: TASK_TIMEOUT_MS,
          maxBuffer: 4 << 20,
        })
        const combined = (stdout || '') + (stderr ? '\n--- stderr ---\n' + stderr : '')
        onProgress?.(combined)
        return `> ${task.label} 完成 (make ${task.makeTarget})\n\n` + truncate(combined, MAX_OUTPUT)
      } catch (err) {
        const e = err as { message?: string; stdout?: string; stderr?: string; code?: number }
        const tail = (e.stdout || '') + (e.stderr ? '\n--- stderr ---\n' + e.stderr : '') || e.message || String(err)
        return `error: ${task.name} failed (exit ${e.code ?? 'unknown'}) — ${truncate(tail, 2000)}`
      }
    },
  } satisfies Tool)
}

const registerWpPublish = (ctx: Context) => {
  for (const task of TASKS) {
    registerWpTask(ctx, task)
  }
  ctx.logger('wp-publish').info('registered %d wordpress-tools tasks: %s', TASKS.length, TASKS.map((t) => t.name).join(', '))
}

export const toolWpPublish = definePlugin(registerWpPublish, 'tool-wp-publish', ['tools'])
