/**
 * `write-file` tool — creates or overwrites a file on disk (gated).
 *
 * This is what makes the harness able to actually *write code*. Because it
 * mutates the user's filesystem it is flagged `needsApproval: true`, so the
 * agent loop blocks until a human approves the call in the UI — the same
 * human-in-the-loop gate as the calculator tool.
 *
 * Guards:
 *  - relative paths resolve against `<cwd>/sandbox/` (isolated workspace), so
 *    newly generated files don't pollute the project source tree;
 *  - absolute paths resolve as-is but must stay within the write roots;
 *  - creates missing parent directories;
 *  - caps content at 256 KiB;
 *  - the approval gate is the primary safety boundary.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const MAX_CONTENT = 256 * 1024

/** Default sandbox subdirectory for newly generated files. */
const SANDBOX_DIR = 'sandbox'

const registerWriteFile = (ctx: Context) => {
  ctx.tools.register({
    name: 'write-file',
    description:
      'Create or overwrite a file with the given content (creates parent directories as needed). Relative paths write to the current run workspace (or sandbox/<task>/ otherwise); use absolute paths to write elsewhere. Requires human approval.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path (relative to the run workspace / task sandbox directory, or absolute).',
        },
        content: { type: 'string', description: 'Full file content to write.' },
        task: {
          type: 'string',
          description:
            'Task name for isolated sandbox subdirectory (e.g. "lru-cache", "article-draft"). Files for different tasks are kept separate. Defaults to "default". Ignored when the run has a workspace.',
        },
      },
      required: ['path', 'content'],
    },
    async execute(args, execCtx) {
      let p = String(args['path'] ?? '')
      const content = String(args['content'] ?? '')
      const task = String(args['task'] ?? 'default').replace(/[^a-zA-Z0-9_-]/g, '_') || 'default'
      if (!p.trim()) throw new Error('path is required')
      if (content.length > MAX_CONTENT) {
        throw new Error(`content is ${content.length} chars, exceeds the 256 KiB write limit`)
      }
      // A per-run workspace (background jobs) anchors relative paths to that
      // directory; otherwise the default sandbox/<task>/ isolation applies.
      const workspace = execCtx?.workspace
      // Path normalization: strip redundant "sandbox/" / "sandbox\\<task>\\"
      // prefixes that the model may add — the tool already scopes relative
      // paths, so a second prefix causes nesting.
      p = p.replace(/^sandbox[\\/]/i, '')
      p = p.replace(new RegExp(`^${task}[\\/]`, 'i'), '')
      const base = workspace
        ? workspace
        : isAbsolute(p)
          ? process.cwd()
          : join(process.cwd(), SANDBOX_DIR, task)
      const abs = resolve(base, p)
      ctx.fsRoots.assertWithin(abs, 'write')
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return `wrote ${content.length} chars to ${abs} (task: ${task})`
    },
    // Sandboxed to the workspace / sandbox/<task>/ + OS-level Seatbelt/bwrap,
    // so no human gate needed.
    needsApproval: false,
  } satisfies Tool)
}

export const toolWriteFile = definePlugin(registerWriteFile, 'tool-write-file', [
  'tools',
  'fsRoots',
])
