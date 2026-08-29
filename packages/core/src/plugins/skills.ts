/**
 * Skills service — reusable instruction packs for the agent.
 *
 * A "skill" is a directory under a skills root containing a `SKILL.md` that
 * describes how to perform a class of tasks (a documented workflow, not code).
 *
 * Supports multiple skill directories merged together:
 *   1. local `<cwd>/skills/` (project-specific skills)
 *   2. `HARNESS_SKILLS_DIR` env var (shared resolve-skills repo, same var as
 *      resolve-tui / resolve-harness) — optional override
 *   2b. `<cwd>/resolve-skills/skills` git submodule, auto-detected (mirrors
 *       resolve-tui) so the shared skills work with zero env config
 *   3. `config.dirs` (explicit extra directories)
 *
 * On name collisions, earlier directories win (local takes precedence over
 * shared). This service:
 *   - scans all directories and indexes each skill (name + description);
 *   - exposes the index as prompt text the agent loop injects into system msg;
 *   - lets the model fetch a skill's full instructions via `read`.
 *
 * SKILL.md format (aligns with Agent Skills / resolve-skills SKILL_SPEC):
 *   ---
 *   name: code-review
 *   description: 审查代码改动并输出结构化报告
 *   ---
 *   # Code Review
 *   步骤...
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { Service } from 'cordis'
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
  /** Extra skill directories to merge (e.g. shared resolve-skills). */
  dirs?: string[]
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
  private readonly dirs: string[]

  constructor(ctx: Context, config: SkillsConfig = {}) {
    super(ctx, 'skills')
    // Build the directory search list in precedence order (earlier wins).
    const dirs: string[] = []
    // 1. Local project skills (highest precedence).
    if (config.dir) {
      dirs.push(config.dir)
    } else {
      dirs.push(join(process.cwd(), 'skills'))
    }
    // 2. Shared resolve-skills via env var (same var as resolve-tui / resolve-harness).
    if (process.env.HARNESS_SKILLS_DIR) {
      dirs.push(process.env.HARNESS_SKILLS_DIR)
    }
    // 2b. Auto-detect the resolve-skills git submodule at <cwd>/resolve-skills
    // (mirrors resolve-tui): the shared skills work with zero env config.
    const submoduleSkills = join(process.cwd(), 'resolve-skills', 'skills')
    if (existsSync(submoduleSkills)) {
      dirs.push(submoduleSkills)
    }
    // 3. Explicit extra dirs from config.
    if (config.dirs) {
      dirs.push(...config.dirs)
    }
    // Deduplicate while preserving order, filter out non-existent dirs at scan time.
    this.dirs = [...new Set(dirs)]
    ctx.logger('skills').info('skill roots: %s', this.dirs.join(', '))
  }

  /** All indexed skills (name + description), merged across all dirs, sorted. */
  async list(): Promise<SkillInfo[]> {
    const seen = new Map<string, SkillInfo>()
    for (const dir of this.dirs) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue // directory doesn't exist — skip
      }
      for (const name of names) {
        if (seen.has(name)) continue // earlier dir already has this skill
        try {
          if (!(await stat(join(dir, name))).isDirectory()) continue
          const raw = (await readFile(join(dir, name, 'SKILL.md'), {
            encoding: 'utf8',
          })) as string
          const fm = parseFrontmatter(raw)
          seen.set(name, { name: fm.name ?? name, description: fm.description ?? '' })
        } catch {
          // folder without a readable SKILL.md — skip
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Full instructions of a skill, or null if it doesn't exist in any dir. */
  async read(name: string): Promise<string | null> {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safe) return null
    for (const dir of this.dirs) {
      try {
        return (await readFile(join(dir, safe, 'SKILL.md'), { encoding: 'utf8' })) as string
      } catch {
        // not in this dir — try the next
      }
    }
    return null
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
      '可用技能（skills）：',
      ...lines,
      '使用某技能时，先用 read-file 读取对应 SKILL.md，再按其步骤执行。',
    ].join('\n')
  }
}

export const skills = definePlugin(SkillsService, 'skills', [])
