/**
 * `analyze-dir` tool — recursively scans a directory and returns a structured
 * report (file tree + per-file size/line counts + short snippets) so the agent
 * can explain what the directory does. Read-only, no approval, sandboxed to the
 * read roots.
 *
 * Designed as a "gather raw material" tool: the LLM turns the report into a
 * human summary, rather than the tool itself doing the prose. This keeps it
 * safe and reusable across "what does this folder do?" prompts.
 *
 * Guards / limits (so a large tree can NEVER blow up the model context):
 *  - path resolved against cwd, must be within `fsRoots.read`;
 *  - skips common junk dirs (node_modules, .git, .venv, caches, ...);
 *  - skips binary files (NUL-byte sniff);
 *  - caps total entries walked (MAX_WALK) for speed on huge repos;
 *  - caps tree lines (MAX_TREE_ENTRIES) and files-with-snippets (MAX_FILES);
 *  - hard output budget (OUTPUT_BUDGET): drops file snippets from the end
 *    until the whole report is under the budget, so the result is always
 *    small enough to fit in the LLM context — even for a 20k-file repo.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
  'out',
  '.pse_tmp',
  '.ruff_cache',
  '.mypy_cache',
  '.pytest_cache',
  '.eggs',
])

const MAX_WALK = 4000 // max entries (files + dirs) to descend into
const MAX_TREE_ENTRIES = 500 // max lines in the printed tree
const MAX_FILES = 40 // max files to include a snippet for
const MAX_SNIPPET = 800 // max chars kept per snippet
const OUTPUT_BUDGET = 36 * 1024 // hard cap on the serialized report (bytes)

interface FileInfo {
  /** Path relative to the scanned directory. */
  path: string
  size: number
  lines: number
  /** Up to the first 800 bytes of the (text) file; empty for binaries/unreadable. */
  snippet: string
}

interface Counters {
  files: number
  dirs: number
  bytes: number
  scanned: number
  walked: number
  treeEntries: number
  truncated: boolean
}

async function walk(
  absDir: string,
  depth: number,
  ignore: Set<string>,
  counters: Counters,
  treeLines: string[],
  files: FileInfo[],
): Promise<void> {
  if (counters.truncated) return

  let entries
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !ignore.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const filesHere = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))

  for (const d of dirs) {
    if (counters.truncated) break
    counters.dirs++
    counters.walked++
    if (counters.walked > MAX_WALK) {
      counters.truncated = true
      break
    }
    if (counters.treeEntries < MAX_TREE_ENTRIES) {
      treeLines.push(`${'  '.repeat(depth)}${d.name}/`)
      counters.treeEntries++
    }
    await walk(join(absDir, d.name), depth + 1, ignore, counters, treeLines, files)
  }

  for (const f of filesHere) {
    if (counters.truncated) break
    const abs = join(absDir, f.name)
    counters.walked++
    if (counters.walked > MAX_WALK) {
      counters.truncated = true
      break
    }
    let info
    try {
      info = await stat(abs)
    } catch {
      continue
    }
    counters.files++
    counters.bytes += info.size
    if (counters.treeEntries < MAX_TREE_ENTRIES) {
      treeLines.push(`${'  '.repeat(depth)}${f.name}`)
      counters.treeEntries++
    }

    if (counters.scanned >= MAX_FILES) continue
    counters.scanned++

    let snippet = ''
    let lines = 0
    try {
      const buf = await readFile(abs)
      if (!buf.includes(0)) {
        const text = buf.toString('utf8', 0, MAX_SNIPPET)
        snippet = text
        lines = text.split('\n').length
      }
    } catch {
      // unreadable — leave snippet empty
    }
    files.push({ path: relative(absDir, abs) || f.name, size: info.size, lines, snippet })
  }
}

const registerAnalyzeDir = (ctx: Context) => {
  ctx.tools.register({
    name: 'analyze-dir',
    description:
      'Recursively scan a directory and return a BOUNDED structured report (file tree, per-file size/line counts, and short snippets) so the agent can explain what the directory does. Read-only, sandboxed, no approval. Output is hard-capped to fit the model context — safe even on very large repos. Use this (not raw directory_tree) to understand an unfamiliar project or folder before summarizing it.',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'Directory path (absolute, or relative to the harness working directory).',
        },
        ignore: {
          type: 'array',
          description:
            'Optional extra directory names to skip (node_modules/.git/.venv/caches are skipped by default).',
        },
        maxFiles: {
          type: 'number',
          description: `Max number of files to include snippets for (default ${MAX_FILES}).`,
        },
      },
      required: ['dir'],
    },
    async execute(args) {
      const p = String(args['dir'] ?? '')
      if (!p.trim()) throw new Error('dir is required')
      const abs = isAbsolute(p) ? p : resolve(process.cwd(), p)
      ctx.fsRoots.assertWithin(abs, 'read')

      let st
      try {
        st = await stat(abs)
      } catch {
        throw new Error(`cannot access directory: ${abs}`)
      }
      if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`)

      const ignore = new Set(DEFAULT_IGNORE)
      if (Array.isArray(args['ignore'])) {
        for (const x of args['ignore'] as unknown[]) {
          if (typeof x === 'string') ignore.add(x)
        }
      }

      const counters: Counters = {
        files: 0,
        dirs: 0,
        bytes: 0,
        scanned: 0,
        walked: 0,
        treeEntries: 0,
        truncated: false,
      }
      const treeLines: string[] = [`${abs}/`]
      const files: FileInfo[] = []
      await walk(abs, 1, ignore, counters, treeLines, files)

      const maxFiles =
        typeof args['maxFiles'] === 'number' ? (args['maxFiles'] as number) : MAX_FILES

      const truncatedByWalk = counters.truncated || counters.scanned >= maxFiles
      const summary = {
        dir: abs,
        totalFiles: counters.files,
        totalDirs: counters.dirs,
        totalBytes: counters.bytes,
        scannedFiles: counters.scanned,
        truncated: truncatedByWalk,
        note: truncatedByWalk
          ? `Scan capped (walked ${counters.walked} entries, ${counters.scanned} files with snippets). Increase maxFiles or narrow the scope to go deeper.`
          : 'Full scan complete.',
      }

      const report = {
        summary,
        tree: treeLines.join('\n'),
        files,
      }

      // Hard output budget: drop file snippets from the end until the whole
      // report serializes under OUTPUT_BUDGET. Guarantees the tool result can
      // never blow the model context, regardless of repo size.
      let serialized = JSON.stringify(report)
      while (serialized.length > OUTPUT_BUDGET && report.files.length > 0) {
        report.files.pop()
        summary.truncated = true
        serialized = JSON.stringify(report)
      }
      if (serialized.length > OUTPUT_BUDGET && report.tree.length > 0) {
        const over = serialized.length - OUTPUT_BUDGET
        report.tree =
          report.tree.slice(0, Math.max(0, report.tree.length - over - 64)) +
          '\n... (tree truncated to fit output budget)'
        serialized = JSON.stringify(report)
      }
      if (summary.truncated && !truncatedByWalk) {
        summary.note = `Output capped to fit the model context (${Math.round(OUTPUT_BUDGET / 1024)}KB budget). Increase maxFiles or narrow the scope for more.`
      }

      return report
    },
  } satisfies Tool)
}

export const toolAnalyzeDir = definePlugin(registerAnalyzeDir, 'tool-analyze-dir', [
  'tools',
  'fsRoots',
])
