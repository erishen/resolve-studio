/**
 * `read-file` tool — reads a file from disk (read-only, no approval).
 *
 * Lets the agent inspect source/config files to ground its reasoning. Safe
 * enough to run without human approval: it never modifies anything. Guards:
 *  - resolves the path against the process cwd (relative paths are allowed);
 *  - rejects binary files (NUL-byte sniff);
 *  - caps the returned size at 64 KiB so a huge file can't blow up context.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

const MAX_BYTES = 64 * 1024

const registerReadFile = (ctx: Context) => {
  ctx.tools.register({
    name: 'read-file',
    description:
      'Read a text file from disk and return its contents (max 64 KiB). Use this to inspect source code or configuration before editing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (absolute, or relative to the harness working directory).' },
      },
      required: ['path'],
    },
    async execute(args) {
      const p = String(args['path'] ?? '')
      if (!p.trim()) throw new Error('path is required')
      const abs = isAbsolute(p) ? p : resolve(process.cwd(), p)
      ctx.fsRoots.assertWithin(abs, 'read')
      const buf = await readFile(abs)
      if (buf.length > MAX_BYTES) {
        throw new Error(`file is ${buf.length} bytes, exceeds the 64 KiB read limit`)
      }
      if (buf.includes(0)) {
        throw new Error('file appears to be binary; refusing to read')
      }
      return buf.toString('utf8')
    },
  } satisfies Tool)
}

export const toolReadFile = definePlugin(registerReadFile, 'tool-read-file', ['tools', 'fsRoots'])
