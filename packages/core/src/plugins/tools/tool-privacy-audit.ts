import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { definePlugin } from '../util.js'
import type { Tool } from '../../types.js'

const execFileAsync = promisify(execFile)

// …/resolve-studio/packages/core/src/plugins/tools, 8 levels up = the workspace
// root (***REMOVED***). Override with PRIVACY_AUDIT_DIR in .env.
const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(HERE, '***REMOVED***')
const AUDIT_SCRIPT =
  process.env.PRIVACY_AUDIT_DIR ?? resolve(WORKSPACE_ROOT, 'tools/privacy/privacy_audit.py')

const STEP_TIMEOUT_MS = 300_000
const STEP_MAX_BUFFER = 16 << 20

interface AuditedRepo {
  check: string
  status: 'PASS' | 'WARN' | 'FAIL'
  details: string[]
}

const registerPrivacyAudit = (ctx: Context) => {
  ctx.tools.register({
    name: 'privacy-audit',
    description:
      '隐私/密钥泄露审计：对指定 git 仓库目录运行 9 项只读检查' +
      '（.gitignore 覆盖 / 已入库敏感文件 / env.example 占位符 / 硬编码密钥 / 绝对路径 / 真实微信号 / git 历史泄露 / 磁盘文件被忽略）。' +
      '用于"帮我审计一下当前 repo 有没有隐私泄露"。' +
      '默认扫描整个工作区（可 target 指定单仓库，--exclude-path 排除不想审计的仓库）。只读，不修改任何文件。',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: `要审计的 git 仓库或根目录（默认 ${WORKSPACE_ROOT}）。传单仓库则只审计它。`,
        },
        exclude_path: {
          type: 'string',
          description:
            '逗号分隔的排除仓库路径前缀（如 "<repoA>/<subdir>,<repoB>"）。',
        },
      },
      required: [],
    },
    needsApproval: false,
    async execute(args): Promise<string> {
      const target = (args.target as string | undefined)?.trim() || WORKSPACE_ROOT
      const excludePath = (args.exclude_path as string | undefined)?.trim()

      const cmdArgs = [AUDIT_SCRIPT, target, '--json', '--no-color']
      if (excludePath) cmdArgs.push('--exclude-path', excludePath)

      let stdout: string
      let exitCode: number
      try {
        const res = await execFileAsync('python3', cmdArgs, {
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: STEP_MAX_BUFFER,
          env: process.env,
        })
        stdout = res.stdout
        exitCode = 0
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
        // The auditor exits 1 when FAILs are found (expected, not a crash). Any
        // other failure (ENOENT python3, spawned crash, timeout) has no stdout —
        // surface it as a tool error instead of a bogus "clean" report.
        if (!e.stdout) {
          return `error: privacy-audit 运行失败 — ${truncate(e.stderr ?? e.message ?? String(err), 800)}`
        }
        stdout = e.stdout
        exitCode = typeof e.code === 'number' ? e.code : 1
      }

      // Tail of the process output holds the JSON payload after the "--JSON--" marker.
      const jsonStart = stdout.lastIndexOf('--JSON--')
      const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart + '--JSON--'.length).trim() : ''
      let parsed: Record<string, AuditedRepo[]>
      try {
        parsed = JSON.parse(jsonText) as Record<string, AuditedRepo[]>
      } catch {
        return `error: privacy-audit 无法解析审计 JSON 输出。\n${truncate(stdout, 2000)}`
      }

      const repos = Object.entries(parsed)
      const failCount = repos.reduce(
        (n, [, checks]) => n + checks.filter((c) => c.status === 'FAIL').length,
        0,
      )

      const lines: string[] = [
        `> privacy-audit 完成：${repos.length} 个仓库，FAIL=${failCount}（退出码 ${exitCode ? '1=存在风险' : '0=通过'}）`,
        '',
      ]
      for (const [repo, checks] of repos.slice(0, 30)) {
        const fails = checks.filter((c) => c.status === 'FAIL')
        const warns = checks.filter((c) => c.status === 'WARN')
        lines.push(
          `**${repo}**${fails.length ? `  ❌ ${fails.length} FAIL` : ''}${warns.length ? `  ⚠️ ${warns.length} WARN` : ''}`,
        )
        for (const c of [...fails, ...warns].slice(0, 8)) {
          lines.push(`  - [${c.status}] ${c.check}`)
          for (const d of c.details.slice(0, 4)) lines.push(`    ${truncate(d, 220)}`)
        }
      }
      lines.push('', '> 完整 JSON 报告见上文原始输出；隐私审计只读，不修改仓库。')

      return lines.join('\n')
    },
  } satisfies Tool)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`
}

export const toolPrivacyAudit = definePlugin(registerPrivacyAudit, 'tool-privacy-audit', ['tools'])
