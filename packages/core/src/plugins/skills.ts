/**
 * Skills service — reusable instruction packs for the agent.
 *
 * A "skill" is a directory under `<cwd>/skills/<name>/` containing a
 * `SKILL.md` that describes how to perform a class of tasks (a documented
 * workflow, not code). This service:
 *   - scans the skills directory and indexes each skill (name + description,
 *     parsed from the SKILL.md frontmatter);
 *   - exposes the index as prompt text (`indexText`) that the agent loop
 *     injects into the system message, so the model *knows* which skills exist;
 *   - lets the model fetch a skill's full instructions via `read` (it calls
 *     the existing `read-file` tool for that, or another plugin can call
 *     `ctx.skills.read()` directly).
 *
 * SKILL.md format:
 *   ---
 *   name: code-review
 *   description: 审查代码改动并输出结构化报告
 *   ---
 *   # Code Review
 *   步骤...
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from 'cordis'
import { definePlugin } from './util.js'

declare module 'cordis' {
  interface Context {
    skills: SkillsService
  }
}

export interface SkillInfo {
  name: string
  description: string
}

export interface SkillsConfig {
  /** Directory containing skill folders (default `<cwd>/skills`). */
  dir?: string
}

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

export class SkillsService extends Service {
  private readonly dir: string

  constructor(ctx: Context, config: SkillsConfig = {}) {
    super(ctx, 'skills')
    this.dir = config.dir ?? join(process.cwd(), 'skills')
  }

  /** All indexed skills (name + description), sorted by name. */
  async list(): Promise<SkillInfo[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    const out: SkillInfo[] = []
    for (const name of names) {
      try {
        if (!(await stat(join(this.dir, name))).isDirectory()) continue
        const raw = (await readFile(join(this.dir, name, 'SKILL.md'), { encoding: 'utf8' })) as string
        const fm = parseFrontmatter(raw)
        out.push({ name: fm.name ?? name, description: fm.description ?? '' })
      } catch {
        // folder without a readable SKILL.md — skip
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Full instructions of a skill, or null if it doesn't exist. */
  async read(name: string): Promise<string | null> {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safe) return null
    try {
      return (await readFile(join(this.dir, safe, 'SKILL.md'), { encoding: 'utf8' })) as string
    } catch {
      return null
    }
  }

  /**
   * Prompt fragment listing available skills. The agent loop injects this
   * into the system message so the model knows what it can follow.
   */
  async indexText(): Promise<string> {
    const list = await this.list()
    if (!list.length) return ''
    const lines = list.map((s) => `- ${s.name}${s.description ? `：${s.description}` : ''}`)
    return [
      '可用技能（skills/ 目录）：',
      ...lines,
      '使用某技能时，先用 read-file 读取 skills/<名称>/SKILL.md，再按其步骤执行。',
    ].join('\n')
  }
}

export const skills = definePlugin(SkillsService, 'skills', [])
