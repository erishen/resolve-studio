import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import { HOST as WEB_HOST, PORT as WEB_PORT } from '../web-server.js'

// 宿主浏览器可访问的前端/网关入口。默认 make dev（后端直连 127.0.0.1:8787）；
// docker 部署里宿主监听的是 nginx 前端端口（18080，/api 反代到 backend:8787），
// 由 docker-compose 注入，否则拼出来的 127.0.0.1:8787 在宿主无人监听、打不开。
const PREVIEW_BASE_URL = process.env.DEV_STATS_PREVIEW_BASE_URL ?? `http://${WEB_HOST}:${WEB_PORT}`

const execFileAsync = promisify(execFile)

/** dev-stats project root, from DEV_STATS_DIR (env-only). Null if unset. */
function devStatsDir(): string | null {
  return process.env.DEV_STATS_DIR ?? null
}

// 掘金/思否/Actions 都是逐仓库拉取的远端查询，仓库多时接近分钟级。
// make csv 现默认带 --detail --community --activity（104 仓约 4 分钟），加流量更久，给足 10 分钟。
const RUN_TIMEOUT_MS = 600_000
const RUN_MAX_BUFFER = 16 << 20

// Avoid control characters in the regex literal (no-control-regex lint rule).
const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')
// Rich's status spinner frames start with a braille glyph; when the CLI is
// piped they repeat the same message hundreds of times, one line per frame.
const SPINNER_RE = /^[\u2800-\u28FF]/

/** Strip ANSI escapes, drop spinner frames, collapse consecutive duplicates. */
function cleanOutput(raw: string): string {
  const lines = raw.replace(ANSI_RE, '').split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (SPINNER_RE.test(line)) continue
    if (line.trim() && kept.length > 0 && kept[kept.length - 1] === line) continue
    kept.push(line)
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Parse manifest-level stats.csv (name + traffic columns) without a dep. */
function parseStatsCsv(path: string): Record<string, string>[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8')
  const rows: string[][] = []
  let fields: string[] = []
  let cur: string[] = []
  let inQ = false
  let field = ''
  const flushField = () => {
    cur.push(field)
    field = ''
  }
  const flushRow = () => {
    if (cur.length === 0) return
    if (!fields.length) fields = cur
    else rows.push(cur)
    cur = []
  }
  for (const ch of raw) {
    if (inQ) {
      if (ch === '"') inQ = false
      else field += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      flushField()
    } else if (ch === '\n' || ch === '\r') {
      flushField()
      flushRow()
    } else {
      field += ch
    }
  }
  flushField()
  flushRow()
  return rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i] ?? ''])))
}

/** 可暴露给 Agent 的 make 目标：全部只读查询或本地导出，不碰依赖与代码。 */
const TARGETS = [
  'report',
  'juejin',
  'segmentfault',
  'ci',
  'actions',
  'csv',
  'csv-traffic',
  'run',
] as const
type Target = (typeof TARGETS)[number]

const TARGET_DESCRIPTIONS: Record<Target, string> = {
  report:
    '汇总掘金 + 思否文章数据，按母文章合并对比（默认 --sort daily 日均阅读）。' +
    '思否默认禁用或拉取失败时自动降级为仅掘金并附说明，不会整体报错。',
  juejin: '掘金文章阅读/点赞/评论（默认 --sort daily，可 ARGS 覆盖）。',
  segmentfault:
    '思否文章阅读/访客/点赞/收藏/评论（默认 --sort daily，可 ARGS 覆盖）。' +
    '思否抓取默认禁用（需 .env 设置 SEGMENTFAULT_ENABLED=true）；未启用时只返回提示、无数据，属正常现象，不要重试。',
  ci:
    'CI 巡检（推荐）：只输出「CI 巡检小结」——失败仓库 + workflow + 失败步骤 + 报错注解，跳过流量采集与仓库大表，约 50 秒。' +
    '问「哪些仓库 CI 挂了」时优先用这个。',
  actions:
    '巡检各仓库 CI 状态并附带完整仓库统计大表（等价 make actions：--actions --no-forks --sort updated --exclude wildsKick,king-power,skeleton-ssr，默认排除 fork 与老仓噪音、按最近推送排序）。' +
    '注意：管道输出里表格的 CI 列会被挤没，只要「哪些挂了」的结论请改用 target=ci。',
  csv: '导出仓库公开统计到 output/stats.csv（等价 make csv：--sort clones --detail --community --activity --no-traffic）。' +
    '--no-traffic 不采 clone/views 流量所以快（约 1-2 分钟），同时生成 stats-preview.html；不含流量列，只适合公开维度分析，热度/clone 排名必须用 csv-traffic。',
  'csv-traffic':
    '导出含 clone/views 流量的完整统计（等价 make csv-traffic：= csv 目标 + 流量采集 + --include-traffic，约 4-5 分钟）。' +
    '问「最近两周哪个仓库 clone 最多 / 热度最高 / 传播数据」时必须用这个——csv 目标不含流量列，拿它回答热度问题必然无数据或导致编造。',
  run: '透传运行 dev-stats CLI（等价 make run ARGS=...），用于上面的目标覆盖不到的参数组合。',
}

const registerDevStats = (ctx: Context) => {
  const targetHelp = TARGETS.map((t) => `${t}：${TARGET_DESCRIPTIONS[t]}`).join('\n')
  ctx.tools.register({
    name: 'dev-stats',
    description:
      '开发者数据统计（dev-stats 项目）：查掘金/思否文章阅读数据、汇总双平台传播对比、' +
      '巡检各仓库 GitHub Actions CI 状态、导出仓库 clone 统计 CSV。' +
      '通过 make 目标执行，全部为只读查询或本地文件导出，不改依赖、不改代码。' +
      '请勿用 shell 直接访问项目目录，所有查询一律走本工具；失败时先读返回的错误信息再决定动作，不要盲目重试。' +
      '导出 CSV 后不要再用 read-file / shell 读取该文件：它位于 dev-stats 项目目录内、已被 .gitignore、可能较大，且 read-file 的相对路径以 harness 工作区为基准、找不到它；直接基于本工具返回的导出结论汇报即可。' +
      '回答里提到预览 HTML 时，必须渲染成完整 URL 的 Markdown 链接方便一键打开：逐字引用工具结果里「预览链接：」后的完整地址（形如 http://127.0.0.1:<端口>/api/raw/stats-preview.html），如 [打开 CSV 预览](http://...)。链接必须以 http:// 开头且整条复制，不要自己改写或拼接路径——相对路径 /api/raw 在前端不可点击，即使本会话历史消息里有旧格式也不要模仿；拿不准就直接告诉用户「点击上方工具卡片中的预览按钮」。' +
      '工具结果末尾附的【仓库热度排名】清单是标准化排名：仓库名/排位/数字一律以此清单为准——上面的 Rich 表格在窄终端会被拆成竖排字符、容易读错（如把 tsm-hub 读成 spring-m-hub），不要根据表格文字拼仓库名。' +
      '输出末尾自带「文章链接」清单（每篇的原文 URL）；回答涉及具体文章时，请把标题渲染成 Markdown 链接指向该 URL，方便直接跳转查看。' +
      '铁律：回答中的仓库名、排名、数值必须逐字取自本工具的实际输出，禁止编造、改写或「补充」任何仓库存在与数字；表格很长时只引用排名靠前的几行，宁少勿错。\n' +
      targetHelp,
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要执行的 make 目标。',
          enum: [...TARGETS],
          default: 'report',
        },
        args: {
          type: 'string',
          description:
            '透传给 make 的 ARGS 变量（如 "--sort views --limit 5" 或 "--limit 20"）。' +
            '各目标的默认参数已内置，仅在需要换排序/条数/过滤时才传。',
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const dir = devStatsDir()
      if (!dir) {
        return 'error: DEV_STATS_DIR is not set. Export it to the absolute path of the dev-stats project root (e.g. in .env).'
      }
      const target = ((args.target as string | undefined)?.trim() || 'report') as Target
      if (!TARGETS.includes(target)) {
        return `error: 未知目标 "${target}"，可用目标：${TARGETS.join(' / ')}。`
      }
      let rawArgs = (args.args as string | undefined)?.trim() ?? ''
      // 容器内没有 gh 登录 / GITHUB_TOKEN / GH_TOKEN 时，dev-stats 必须显式给 --user，
      // 否则直接"未指定 --user，且未检测到登录态"退出。仅当调用方已显式指定身份
      // （--user/--token）或存在 token 环境变量时才不加；内容平台子命令（juejin/
      // segmentfault/report）用户标识语义不同，也不加。
      const needsIdentity =
        target !== 'juejin' &&
        target !== 'segmentfault' &&
        target !== 'report' &&
        !/\b--user\b|\b--token\b/.test(rawArgs) &&
        !process.env.GITHUB_TOKEN &&
        !process.env.GH_TOKEN
      if (needsIdentity) {
        const defaultUser = process.env.DEV_STATS_USER ?? 'erishen'
        rawArgs = `${rawArgs} --user ${defaultUser}`.trim()
      }
      const makeArgs: string[] = [target]
      if (rawArgs) makeArgs.push(`ARGS=${rawArgs}`)

      // 剥离继承自终端的 TTY 痕迹：否则 Rich 会把管道当终端，
      // status spinner 每帧都打一行，几百行重复刷屏。
      const env = { ...process.env }
      delete env.FORCE_COLOR
      delete env.CLICOLOR_FORCE
      env.NO_COLOR = '1'
      env.TERM = 'dumb'

      try {
        const res = await execFileAsync('make', makeArgs, {
          cwd: dir,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: RUN_MAX_BUFFER,
          env,
        })
        const out = cleanOutput(`${res.stdout}\n${res.stderr}`)
        const body = [
          `dev-stats make ${target}${rawArgs ? ` ARGS=${rawArgs}` : ''}：`,
          '',
          out || '（无输出）',
        ]
        // 导出了文件时附上项目绝对路径，agent 才能告诉用户去哪里打开产物。
        if (out.includes('已导出 CSV') || out.includes('已生成 CSV 预览')) {
          body.push(`输出目录：${dir}`)
        }
        // 预览 HTML 给出绝对路径 + 完整链接：前端据此渲染「在浏览器打开」按钮。
        // 完整 URL 是关键兜底——旧版桌面端只认 http 链接（.html 结尾），不认本地路径。
        const previewRel = /已生成 CSV 预览：(\S+)/.exec(out)?.[1]
        if (previewRel) {
          const previewAbs = `${dir}/${previewRel.replace(/^\.\//, '')}`
          body.push(`预览文件：${previewAbs}`)
          // 短形态 /api/raw/<文件名>：按钮标签取 URL 最后一段，长形态
          // raw?path=%2F... 整段编码后撑破屏幕；短形态标签就是干净的文件名。
          const base = previewRel.split('/').pop() ?? ''
          const shortUrl = `${PREVIEW_BASE_URL}/api/raw/${base}`
          body.push(`预览链接：${shortUrl}`)
        }
        // CLI 大表格在窄终端里会按字符拆列换行，模型读不准仓库名（曾把 tsm-hub
        // 读成 spring-m-hub）。这里直接从 stats.csv 解析出一份不换行的干净排名，
        // 仓库名/排位/数字一律以这份清单为准，别用上面的表格猜。
        if (target === 'csv' || target === 'csv-traffic') {
          const rows = parseStatsCsv(`${dir}/output/stats.csv`)
          if (rows.length > 0) {
            const byClone = [...rows]
              .filter((r) => Number(r.cloners_14d ?? 0) > 0)
              .sort((a, b) => Number(b.cloners_14d ?? 0) - Number(a.cloners_14d ?? 0))
              .slice(0, 10)
              .map((r) => `${r.name}（近14天独立clone ${r.cloners_14d ?? 0} / clone总 ${r.clones_total_14d ?? 0} / views ${r.views_total_14d ?? 0}）`)
            if (byClone.length > 0) {
              body.push('', '【仓库热度排名（按近14天独立clone数，来自 stats.csv，仓库名以此处为准）】')
              byClone.forEach((line, i) => body.push(`${i + 1}. ${line}`))
              body.push(
                '⚠ 注意：仓库名一律以上方排名清单为准，不要自行编造、拼凑或凭记忆补全。' +
                  '清单里没有出现的名字就是本次统计里没有的，宁可少写也不要写出来。'
              )
            }
          }
        }
        return body.join('\n')
      } catch (err) {
        const e = err as { message?: string; stderr?: string; stdout?: string }
        const detail = e.stderr ?? e.stdout ?? e.message ?? String(err)
        return `error: dev-stats make ${target} 失败 — ${detail.slice(0, 800)}`
      }
    },
  })
}

export const toolDevStats = definePlugin(registerDevStats, 'tool-dev-stats', ['tools'])
