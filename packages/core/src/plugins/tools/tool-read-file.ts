/**
 * `read-file` tool — reads a file from disk (read-only, no approval).
 *
 * Lets the agent inspect source/config files to ground its reasoning. Safe
 * enough to run without human approval: it never modifies anything. Guards:
 *  - resolves the path against the process cwd (relative paths are allowed);
 *  - rejects binary files (NUL-byte sniff);
 *  - pages by LINE numbers (what models naturally pass as `offset`), each
 *    call capped at 64 KiB so a huge file can't blow up context in one shot.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const MAX_BYTES = 64 * 1024
const MAX_LINES = 2000

const registerReadFile = (ctx: Context) => {
  // Surface the *runtime-resolved* read sandbox so the agent uses real paths
  // (host and container each report their own roots).
  const readableRoots = ctx.fsRoots.read
  const sandboxNote = readableRoots.length
    ? `\nSandbox (authoritative): absolute paths are accepted under these read roots — ${readableRoots.join(', ')}. Paths outside (or non-existent like "/app/workspace/…") are blocked; check the target file path against these roots first.`
    : ''
  ctx.tools.register({
    name: 'read-file',
    description:
      'Read a text file from disk and return its contents (up to 2000 lines / 64 KiB per call). ' +
      'For large files, pass `offset` (1-based line number, default 1) and `limit` (max lines, ' +
      'default 2000) to page through; the response reports the line range and total line count ' +
      'so you can decide the next offset.' +
      sandboxNote,
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
            '1-based line number to start reading from (default 1). Use with `limit` to page through a large file.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum lines to read in this call (default / max 2000).',
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
      // Paging is LINE-based: models pass line numbers (e.g. offset=840,
      // limit=60 meaning "read lines 840-900"), and a raw byte slice starting
      // mid-line is unreadable — the agent used to retry the same read six
      // times getting the same 60-byte fragment. Lines are accumulated until
      // the per-call 64 KiB cap so context still can't be flooded.
      const text = buf.toString('utf8')
      const lines = text.split('\n')
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop() // trailing newline
      const total = lines.length
      const startLine = Math.max(1, Math.trunc(Number(args['offset']) || 1))
      if (startLine > total) {
        return `(已到文件末尾) read-file ${p} offset=${startLine} > total lines=${total}`
      }
      const requested = Math.trunc(Number(args['limit']) || MAX_LINES)
      const maxLines = Math.max(1, Math.min(requested || MAX_LINES, MAX_LINES))
      const start = startLine - 1
      const end = Math.min(start + maxLines, total)
      // Trim to the byte cap (the first line is always included, matching the
      // old behaviour of returning at least something).
      const out: string[] = []
      let bytes = 0
      let last = start
      for (; last < end; last++) {
        const b = Buffer.byteLength(lines[last] + '\n', 'utf8')
        if (out.length > 0 && bytes + b > MAX_BYTES) break
        out.push(lines[last])
        bytes += b
      }
      const next = last < end ? last + 1 : end + 1
      const chunk = out.join('\n')
      const more = next <= total ? `，继续读取请用 offset=${next}` : ''
      return `[read-file ${p} lines ${start + 1}..${Math.min(next - 1, total)} / total ${total}${more ? ` ${more}` : ''}]\n${chunk}`
    },
  })
}

export const toolReadFile = definePlugin(registerReadFile, 'tool-read-file', ['tools', 'fsRoots'])
