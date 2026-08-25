/**
 * `write-file` tool — creates or overwrites a file on disk (gated).
 *
 * This is what makes the harness able to actually *write code*. Because it
 * mutates the user's filesystem it is flagged `needsApproval: true`, so the
 * agent loop blocks until a human approves the call in the UI — the same
 * human-in-the-loop gate as the calculator tool.
 *
 * Guards:
 *  - resolves the path against the process cwd;
 *  - creates missing parent directories;
 *  - caps content at 256 KiB;
 *  - the approval gate is the primary safety boundary.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

const MAX_CONTENT = 256 * 1024

const registerWriteFile = (ctx: Context) => {
  ctx.tools.register({
    name: 'write-file',
    description:
      'Create or overwrite a file with the given content (creates parent directories as needed). Requires human approval. Use after read-file when you need to edit code.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the harness working directory).' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
    },
    async execute(args) {
      const p = String(args['path'] ?? '')
      const content = String(args['content'] ?? '')
      if (!p.trim()) throw new Error('path is required')
      if (content.length > MAX_CONTENT) {
        throw new Error(`content is ${content.length} chars, exceeds the 256 KiB write limit`)
      }
      const abs = isAbsolute(p) ? p : resolve(process.cwd(), p)
      ctx.fsRoots.assertWithin(abs, 'write')
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return `wrote ${content.length} chars to ${abs}`
    },
    needsApproval: true,
  } satisfies Tool)
}

export const toolWriteFile = definePlugin(registerWriteFile, 'tool-write-file', ['tools', 'fsRoots'])
