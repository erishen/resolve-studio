/**
 * `skill-run` tool — explicitly trigger a skill.
 *
 * The model normally discovers skills via the injected index and then reads
 * the SKILL.md with the `read-file` tool. That indirect path is brittle: the
 * model may forget to read the file, or guess the wrong path. `skill-run`
 * lets the agent (or a user) pull a skill's full instructions directly and
 * deterministically — no path-guessing, no dependency on the model "remembering"
 * to open the file.
 *
 * Read-only: it returns the skill's SKILL.md text (and lists any bundled
 * `scripts/`), so it needs no approval.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

const registerSkillRun = (ctx: Context) => {
  ctx.tools.register({
    name: 'skill-run',
    description:
      'Load a skill\'s full instructions by name (reads skills/<name>/SKILL.md and lists any scripts/). Use this to start following a documented workflow reliably, instead of guessing the file path. Read-only, no approval.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name, e.g. "weekly-investment-review".' },
      },
      required: ['name'],
    },
    async execute(args) {
      const name = String(args['name'] ?? '').trim()
      if (!name) throw new Error('name is required')
      const full = ctx.skills ? await ctx.skills.read(name) : null
      if (!full) {
        const available = ctx.skills ? (await ctx.skills.list()).map((s) => s.name).join(', ') : ''
        return `error: skill "${name}" not found${available ? `. Available: ${available}` : ''}`
      }
      let extra = ''
      try {
        const dir = join(process.cwd(), 'skills', name, 'scripts')
        const scripts = (await readdir(dir)).filter((f) => !f.startsWith('.'))
        if (scripts.length) {
          extra = `\n\nAvailable scripts (run via shell if needed):\n${scripts.map((s) => `- scripts/${s}`).join('\n')}`
        }
      } catch {
        // no scripts dir — fine
      }
      return `## Skill: ${name}\n\n${full}${extra}`
    },
  } satisfies Tool)
}

export const toolSkillRun = definePlugin(registerSkillRun, 'tool-skill-run', ['tools', 'skills'])
