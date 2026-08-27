/**
 * @resolve-studio/plugin-pse — PSE (Planner-Specialist-Evaluator) three-role mode.
 *
 * Loads role definitions from a souls directory and, when enabled, injects a
 * role summary into the agent's system message so the model follows the PSE
 * workflow. Full role definitions are read on demand via the read-file tool.
 *
 * Configuration (env):
 *   PSE_ENABLED=true|false   — activate PSE mode (default: false)
 *   PSE_SOULS_DIR=<path>     — dir containing planner/evaluator/specialist
 *                              subdirs, each with SOUL.md (default: derived from
 *                              HARNESS_SKILLS_DIR/../souls if set)
 *
 * Pure-Cordis plugin: only `cordis` is imported, so it is ecosystem-portable.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    pse: PseService
  }
}

export interface SoulInfo {
  name: string
  description: string
}

export interface PseConfig {
  /** Whether PSE mode is active. */
  enabled?: boolean
  /** Directory containing planner/evaluator/specialist subdirs. */
  soulsDir?: string
}

const ROLES = ['planner', 'specialist', 'evaluator'] as const
type Role = (typeof ROLES)[number]

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

function defaultSoulsDir(): string | undefined {
  const skillsDir = process.env.HARNESS_SKILLS_DIR
  if (skillsDir) {
    return join(skillsDir, '..', 'souls')
  }
  return undefined
}

export class PseService extends Service {
  private _enabled: boolean
  private readonly soulsDir: string | undefined

  constructor(ctx: Context, config: PseConfig = {}) {
    super(ctx, 'pse')
    this._enabled = config.enabled ?? process.env.PSE_ENABLED === 'true'
    this.soulsDir = config.soulsDir ?? process.env.PSE_SOULS_DIR ?? defaultSoulsDir()
    ctx.logger('pse').info(
      'PSE %s (soulsDir=%s)',
      this._enabled ? 'enabled' : 'disabled',
      this.soulsDir ?? 'not set',
    )
  }

  /** Whether PSE mode is currently active. */
  get enabled(): boolean {
    return this._enabled
  }

  /** Toggle PSE mode at runtime. */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled
    this.ctx.logger('pse').info('PSE %s at runtime', enabled ? 'enabled' : 'disabled')
  }

  /** Index of all three roles (name + description), or empty if disabled. */
  async list(): Promise<SoulInfo[]> {
    if (!this.enabled || !this.soulsDir) return []
    const out: SoulInfo[] = []
    for (const role of ROLES) {
      try {
        const raw = (await readFile(join(this.soulsDir, role, 'SOUL.md'), {
          encoding: 'utf8',
        })) as string
        const fm = parseFrontmatter(raw)
        out.push({ name: fm.name ?? role, description: fm.description ?? '' })
      } catch {
        // role file missing — skip
      }
    }
    return out
  }

  /** Full SOUL.md content for a given role, or null if missing/disabled. */
  async read(role: string): Promise<string | null> {
    if (!this.enabled || !this.soulsDir) return null
    const safe = role.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safe || !ROLES.includes(safe as Role)) return null
    try {
      return (await readFile(join(this.soulsDir, safe, 'SOUL.md'), {
        encoding: 'utf8',
      })) as string
    } catch {
      return null
    }
  }

  /**
   * Prompt fragment describing the PSE three-role workflow. Injected into the
   * system message when PSE is enabled so the model follows the discipline.
   */
  async systemPrompt(): Promise<string> {
    const roles = await this.list()
    if (!roles.length) return ''
    const lines = roles.map((r) => `- ${r.name}：${r.description}`)
    return [
      '## PSE 三角色工作流（已启用）',
      '本次对话遵循 Planner-Specialist-Evaluator 三角色协作模式：',
      ...lines,
      '需要详细角色定义时，用 read-file 读取对应 SOUL.md。',
      'Planner 负责规划分解与交付验证，不亲自写实现代码；',
      'Specialist 负责具体执行；Evaluator 独立验收，不参与实现。',
    ].join('\n')
  }
}

export default (ctx: Context, config: PseConfig = {}) => {
  ctx.plugin(PseService, config)
}
