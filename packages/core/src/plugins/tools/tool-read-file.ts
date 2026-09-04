/**
 * `read-file` tool — reads a file from disk (read-only, no approval).
 *
 * Lets the agent inspect source/config files to ground its reasoning. Safe
 * enough to run without human approval: it never modifies anything. Guards:
 *  - resolves the path against the process cwd (relative paths are allowed);
 *  - rejects binary files (NUL-byte sniff);
 *  - caps each read at 64 KiB (a huge file can't blow up context in one shot),
 *    but supports `offset` / `limit` so a large file can be read in slices.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const MAX_BYTES = 64 * 1024

const registerReadFile = (ctx: Context) => {
  ctx.tools.register({
    name: 'read-file',
    description:
      'Read a text file from disk and return its contents (up to 64 KiB per call). ' +
      'For large files, pass `offset` (byte position) and `limit` (bytes to read, max 65536) ' +
      'to read it in slices; the response reports the slice range and total size so you can ' +
      'decide the next offset.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path (absolute, or relative to the harness working directory).',
        },
        offset: {
          type: 'integer',
          description:
            'Byte offset to start reading from (default 0). Use with `limit` to page through a large file.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum bytes to read in this call (default / max 65536).',
        },
      },
      required: ['path'],
    },
    async execute(args, execCtx) {
      const p = String(args['path'] ?? '')
      if (!p.trim()) throw new Error('path is required')
      // Per-run workspace (background jobs) anchors relative paths; otherwise
      // they resolve against the process cwd.
      const base = execCtx?.workspace ?? process.cwd()
      const abs = isAbsolute(p) ? p : resolve(base, p)
      ctx.fsRoots.assertWithin(abs, 'read')
      const buf = await readFile(abs)
      if (buf.includes(0)) {
        throw new Error('file appears to be binary; refusing to read')
      }
      // Slicing: keep the per-call 64 KiB cap but allow paging through larger
      // files so the model can inspect big reports without flooding context.
      const offset = Math.max(0, Math.trunc(Number(args['offset']) || 0))
      const requested = Number(args['limit'] ?? MAX_BYTES)
      const limit = Math.max(1, Math.min(Math.trunc(requested) || MAX_BYTES, MAX_BYTES))
      if (offset >= buf.length) {
        return `(已到文件末尾) read-file ${p} offset=${offset} ≥ total=${buf.length}`
      }
      const end = Math.min(offset + limit, buf.length)
      const chunk = buf.subarray(offset, end).toString('utf8')
      const more = end < buf.length ? `，继续读取请用 offset=${end}` : ''
      return `[read-file ${p} bytes ${offset}..${end} / total ${buf.length}${more ? ` ${more}` : ''}]\n${chunk}`
    },
  } satisfies Tool)
}

export const toolReadFile = definePlugin(registerReadFile, 'tool-read-file', ['tools', 'fsRoots'])
