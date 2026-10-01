import * as path from 'node:path'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool, ToolExecutionContext } from '../../types.js'
import { runDesktopLogin } from '../desktop-login.js'

// wordpress-tools 挂载进容器；发布脚本从 WORDPRESS_TOOLS_DIR 读会话文件（.sf-state.json）。
// 不把个人路径写死进源码（隐私红线）。
const WP_TOOLS = process.env.WORDPRESS_TOOLS_DIR

// 桌面专用登录开关（默认关闭）：未启用时工具直接拒绝，避免账号登录能力对 agent
// 无约束暴露。启用需在 .env 设 SF_LOGIN_ENABLED=1（与桌面面板按钮同源）。
const SF_LOGIN_ENABLED = process.env.SF_LOGIN_ENABLED === '1'

// 目标登录链接可配置（SF_LOGIN_URL），不写死具体平台；未配置且未传 url 参数时报错。
const SF_LOGIN_URL = process.env.SF_LOGIN_URL ?? ''

const DEFAULT_WAIT_MS = 180_000
const MAX_WAIT_MS = 600_000
const MIN_WAIT_MS = 10_000

/**
 * Agent-callable "桌面登录"工具：在容器虚拟桌面（VNC, DISPLAY :99）打开可见
 * Chrome 并导航到目标站点，等待用户在 noVNC 视图里完成交互式登录（滑块/2FA），
 * 超时后关闭窗口、保存登录态。默认打开 SF_LOGIN_URL 配置的登录页并导出会话文件
 * （.sf-state.json）供发布任务复用——这样 agent 在发布任务会话过期时可自动回退
 * 到本工具开窗口、用户过滑块、再继续发布。
 * 受 SF_LOGIN_ENABLED 开关约束（涉及账号登录，默认不暴露）。
 */
export const toolDesktopLogin = definePlugin(
  (ctx: Context) => {
    ctx.tools.register({
      name: 'desktop-login',
      description:
        '在容器的虚拟桌面（VNC, DISPLAY :99）打开一个可见 Chrome 并导航到指定 URL，等待用户在 noVNC 桌面视图里完成交互式登录（滑块/2FA），超时后关闭窗口并保存登录态到持久化档案。' +
        '默认打开 SF_LOGIN_URL 配置的登录页并把登录态导出到 WORDPRESS_TOOLS_DIR/.sf-state.json，供对应发布任务复用。' +
        '调用后请明确告诉用户：切到桌面面板，在 noVNC 视图里完成登录（窗口打开期间约 60s 内），登录态会自动保存；保存后即可再触发对应的发布任务。' +
        '本工具会阻塞到 wait_ms（默认 180000ms），期间用户须在 VNC 内完成登录。' +
        '仅在这些场景使用：① 用户明确要求打开目标站点登录窗口；② 对应发布任务因会话过期报错且用户在场可登录。' +
        '不要对普通发布请求无脑调用——应先直接调发布任务，只有它报会话过期时才回退到本工具。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要登录的站点地址（http(s):// 开头）；缺省用 SF_LOGIN_URL 配置值',
          },
          wait_ms: {
            type: 'integer',
            description:
              '等待用户完成登录的毫秒数，上限 ' + MAX_WAIT_MS + '，默认 ' + DEFAULT_WAIT_MS,
          },
          export_sf_state: {
            type: 'boolean',
            description:
              '是否把登录态导出到会话文件（.sf-state.json）供发布任务复用；默认 true（登录非目标站建议 false 以免覆盖会话文件）',
          },
        },
      },
      async execute(args: Record<string, unknown>, _ctx?: ToolExecutionContext): Promise<string> {
        if (!SF_LOGIN_ENABLED) {
          return 'error: 桌面登录未启用 — 请在 .env 中设置 SF_LOGIN_ENABLED=1（涉及账号登录与会话文件写回，默认关闭）。'
        }
        const url =
          typeof args.url === 'string' && /^https?:\/\//i.test(args.url) ? args.url : SF_LOGIN_URL
        if (!url) {
          return 'error: 未配置目标登录地址 — 请在 .env 中设置 SF_LOGIN_URL，或在调用时传 url 参数。'
        }
        const rawWait = Number(args.wait_ms)
        const waitMs = Number.isFinite(rawWait)
          ? Math.min(Math.max(rawWait, MIN_WAIT_MS), MAX_WAIT_MS)
          : DEFAULT_WAIT_MS
        const exportSf = args.export_sf_state !== false
        const exportStatePath =
          exportSf && WP_TOOLS ? path.join(WP_TOOLS, '.sf-state.json') : undefined

        const result = await runDesktopLogin(url, waitMs, exportStatePath)
        if (!result.ok) {
          return `error: 桌面登录未启动：${result.message ?? '未知原因'}（可能已有另一个桌面登录会话在进行中）`
        }
        const sitesLine = result.sites.length
          ? `已保存登录态的域名：${result.sites.join('、')}`
          : '未检测到登录态 Cookie（请确认是否在 VNC 里完成了登录）'
        const sfLine = result.stateExported
          ? '\n✅ 登录态已写回会话文件，现在可直接触发对应的发布任务。'
          : ''
        return (
          `已在 VNC 桌面打开 ${url}（等待 ${Math.round(waitMs / 1000)}s）。\n` +
          `请在桌面面板的 noVNC 视图里完成登录（滑块/2FA），窗口关闭后登录态自动保存。\n` +
          sitesLine +
          sfLine
        )
      },
    } satisfies Tool)
  },
  'tool-desktop-login',
  ['tools'],
)
