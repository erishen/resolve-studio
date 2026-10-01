import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'
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
      '建掘金草稿：调用 wordpress-tools 的 `make juejin-draft`，为下一篇未发布文章创建掘金草稿并写回 juejin_draft_id。每次只处理一篇。需要 wordpress-tools/.env 中的掘金 cookie。⚠️ 每次调用本工具自动建队列中的下一篇；要连续建多篇就重复调用本工具，不要自己用 shell 跑 node 命令。',
  },
  {
    name: 'wechat-draft',
    label: '微信草稿',
    makeTarget: 'wechat-draft',
    description:
      '建微信公众号草稿：调用 wordpress-tools 的 `make wechat-draft`，为下一篇未发布文章创建公众号草稿箱草稿并写回 wechat_draft_id。每次只处理一篇。必须在本机 Mac 运行（微信校验 IP），需要 .env 中的 appid/appsecret。⚠️ 每次调用本工具自动建队列中的下一篇；要连续建多篇就重复调用本工具，不要自己用 shell 跑 node 命令。',
  },
  {
    name: 'sf-pw-publish',
    label: '思否发布',
    makeTarget: 'sf-pw-publish',
    description:
      '思否发布（Playwright 真浏览器版）：调用 wordpress-tools 的 `make sf-pw-publish`，启动浏览器登录思否并发布下一篇未发布文章，写回 sf_id。每次只发一篇。需要 Chrome 已登录思否（或设置 SF_USER_DATA_DIR）。⚠️ 每次调用本工具自动发队列中的下一篇；要连续发多篇就重复调用本工具，不要自己用 shell 跑 node 命令（cwd 不对会找不到模块）。',
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
      // 真浏览器发布任务：先校验登录态，避免在容器/无显示环境里傻等登录超时却看不出原因。
      // 会话存于 .sf-state.json（storageState 纯文本、不绑钥匙串，容器与 Mac 共享同一 bind 挂载文件）。
      if (task.name === 'sf-pw-publish') {
        const statePath = path.join(WP_TOOLS, '.sf-state.json')
        if (!existsSync(statePath)) {
          return (
            `error: 登录态未建立（${statePath} 不存在）。\n` +
            `请先登录一次以写回新鲜登录态，二选一：\n` +
            `   ① 宿主 Mac 终端：进入你本机的 wordpress-tools 目录（即挂载为容器内 ${WP_TOOLS} 的那个），运行 make sf-pw-publish（会弹 Chrome，登录后写回）。\n` +
            `   ② 或开 resolve-studio 桌面面板点专用登录按钮，在 VNC 里登录后自动写回 .sf-state.json（全程在容器内，免切终端）。\n` +
            `两种方式写回的是同一份 .sf-state.json，刷新后 resolve-studio 复用即可自动发布。`
          )
        }
        const ageMs = Date.now() - statSync(statePath).mtimeMs
        const MAX_AGE_MS = 7 * 24 * 3600 * 1000
        if (ageMs > MAX_AGE_MS) {
          const ageDays = (ageMs / 86400000).toFixed(1)
          return (
            `error: 登录态可能已过期（${statePath} 最后刷新 ${ageDays} 天前，超过 7 天阈值）。\n` +
            `请刷新会话后重试，二选一：\n` +
            `   ① 宿主 Mac 终端：进入你本机的 wordpress-tools 目录（即挂载为容器内 ${WP_TOOLS} 的那个），运行 make sf-pw-publish。\n` +
            `   ② 或开 resolve-studio 桌面面板点专用登录按钮，在 VNC 里登录后自动写回 .sf-state.json（全程在容器内，免切终端）。`
          )
        }
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
        const tail =
          (e.stdout || '') + (e.stderr ? '\n--- stderr ---\n' + e.stderr : '') ||
          e.message ||
          String(err)
        // 会话过期/未登录：脚本会打 SF_SESSION_EXPIRED 或「已保存登录态已失效」，识别后补一行刷新指引。
        const hint = /SF_SESSION_EXPIRED|登录态已失效|未登录思否|PHPSESSID/.test(tail)
          ? `\n💡 看起来是登录态失效：请刷新会话后重试——可在宿主 wordpress-tools 目录运行 make sf-pw-publish，或开 resolve-studio 桌面面板点专用登录按钮（VNC 内登录自动写回 .sf-state.json）。`
          : ''
        return `error: ${task.name} failed (exit ${e.code ?? 'unknown'}) — ${truncate(tail, 2000)}${hint}`
      }
    },
  } satisfies Tool)
}

const registerWpPublish = (ctx: Context) => {
  for (const task of TASKS) {
    registerWpTask(ctx, task)
  }
  ctx
    .logger('wp-publish')
    .info(
      'registered %d wordpress-tools tasks: %s',
      TASKS.length,
      TASKS.map((t) => t.name).join(', '),
    )
}

export const toolWpPublish = definePlugin(registerWpPublish, 'tool-wp-publish', ['tools'])
