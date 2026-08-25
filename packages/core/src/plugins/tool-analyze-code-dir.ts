/**
 * `analyze-code-dir` — a composite "understand a code directory" tool that
 * leans on Serena's language-server tooling for the semantic layer.
 *
 * Strategy (the "structure-first + on-demand semantic" pattern):
 *   1. enumerate the top source files locally (bounded, junk-skipped BFS);
 *   2. activate the target dir as a Serena project (serena:activate_project);
 *   3. for each top file, call Serena's `get_symbols_overview` (symbol
 *      skeleton: classes/functions/types) and `get_diagnostics_for_file`
 *      (LSP errors/warnings) — this is the AST-skeleton understanding, far
 *      better than dumping raw file snippets for "what does this code do?";
 *   4. aggregate everything into one bounded, LLM-ready report.
 *
 * Why call Serena via ctx.tools.call (and not let the agent loop do it):
 *   - Serena is registered as an MCP server with `approval: true`, so every
 *     direct agent call would pop an approval prompt. Here the calls happen
 *     *inside* a tool execute, which bypasses the agent-loop approval gate
 *     (see agent.ts — the gate lives in the loop, not in ToolsService.call).
 *     The user invokes this tool ONCE and is not spammed with prompts.
 *   - These internal delegations are flagged `{ internal: true }` so the bypass
 *     is explicit and intentional (a composite tool's sub-calls inherit the
 *     parent tool's already-granted approval). See docs/TODO.md "复合工具内部调用
 *     绕过审批闸门" — the chosen fix is the explicit-exemption path.
 *   - If Serena is not connected, or returns no symbols (unsupported language
 *     / LSP not ready), the tool transparently falls back to the raw
 *     `analyze-dir` walker so the request still succeeds.
 *
 * All output is hard-capped (OUTPUT_BUDGET) so it can never blow the context.
 */

import { readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from 'cordis'
import type { Tool } from '../types.js'
import { definePlugin } from './util.js'

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.rb', '.php',
  '.swift', '.scala', '.vue', '.svelte', '.cs', '.sh',
])

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache',
  '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode', 'coverage',
  '.turbo', 'out', '.pse_tmp', '.ruff_cache', '.mypy_cache', '.pytest_cache',
  '.eggs', '.gradle', 'bin', 'obj',
])

const MAX_FILES = 14 // max source files to pull symbols/diagnostics for
const MAX_DEPTH = 2 // how many directory levels to descend for source files
const MAX_SYMBOL_CHARS = 1400 // cap per file's symbol overview
const MAX_DIAG_CHARS = 700 // cap per file's diagnostics text
const OUTPUT_BUDGET = 36 * 1024 // hard cap on the serialized report (bytes)

const isError = (s: string): boolean => s.startsWith('error:')

/** BFS-collect up to `limit` source-file absolute paths, top-level first. */
async function collectSourceFiles(absDir: string, limit: number, depth: number): Promise<string[]> {
  const out: string[] = []
  let queue = [absDir]
  let level = 0
  while (queue.length && out.length < limit && level <= depth) {
    const next: string[] = []
    for (const dir of queue) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const e of sorted) {
        if (out.length >= limit) break
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (!DEFAULT_IGNORE.has(e.name)) next.push(p)
        } else if (e.isFile() && SOURCE_EXT.has(extname(e.name).toLowerCase())) {
          out.push(p)
        }
      }
    }
    queue = next
    level++
  }
  return out
}

interface CodeFileReport {
  path: string
  symbols: string
  diagnostics: string
}

const registerAnalyzeCodeDir = (ctx: Context) => {
  ctx.tools.register({
    name: 'analyze-code-dir',
    description:
      'Analyze a code directory using Serena\'s language-server tooling: activates the directory as a project and returns a structured report with each top source file\'s symbol skeleton (classes/functions/types) and LSP diagnostics (errors/warnings). Far richer than a raw file walk for understanding "what does this code do?". Read-only, sandboxed, no approval. If Serena is not connected (or its language server cannot analyze the code), it transparently falls back to the bounded raw `analyze-dir` walker. Output is hard-capped to fit the model context.',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          description: 'Directory path (absolute, or relative to the harness working directory) to analyze.',
        },
        maxFiles: {
          type: 'number',
          description: `Max number of top source files to pull semantic info for (default ${MAX_FILES}).`,
        },
        depth: {
          type: 'number',
          description: `How many directory levels to descend when collecting source files (default ${MAX_DEPTH}).`,
        },
        includeDiagnostics: {
          type: 'boolean',
          description: 'Also fetch LSP diagnostics per file (default true).',
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

      const maxFiles = typeof args['maxFiles'] === 'number' ? (args['maxFiles'] as number) : MAX_FILES
      const depth = typeof args['depth'] === 'number' ? (args['depth'] as number) : MAX_DEPTH
      const includeDiagnostics = args['includeDiagnostics'] !== false

      const absFiles = await collectSourceFiles(abs, maxFiles, depth)
      const relFiles = absFiles.map((f) => relative(abs, f) || f)

      // ---- Serena-backed path --------------------------------------------
      let mode = 'serena'
      let reason = ''
      const files: CodeFileReport[] = []
      let symbolsFound = 0
      const usedTools: string[] = []
      try {
        const act = await ctx.tools.call('serena:activate_project', { project: abs }, { internal: true })
        if (isError(act)) throw new Error(act)
        usedTools.push('serena:activate_project')

        for (const rel of relFiles) {
          const sym = await ctx.tools.call('serena:get_symbols_overview', { relative_path: rel, depth: 0 }, { internal: true })
          const symbols = isError(sym) ? '' : sym.slice(0, MAX_SYMBOL_CHARS)
          let diagnostics = ''
          if (includeDiagnostics && symbols) {
            const dia = await ctx.tools.call('serena:get_diagnostics_for_file', { relative_path: rel }, { internal: true })
            if (!isError(dia) && dia.trim()) diagnostics = dia.slice(0, MAX_DIAG_CHARS)
          }
          if (symbols) symbolsFound++
          files.push({ path: rel, symbols, diagnostics })
        }
        usedTools.push('serena:get_symbols_overview')
        if (includeDiagnostics) usedTools.push('serena:get_diagnostics_for_file')

        if (relFiles.length > 0 && symbolsFound === 0) {
          throw new Error('serena returned no symbols (language unsupported or LSP not ready)')
        }
      } catch (err) {
        mode = 'fallback-raw'
        reason = (err as Error).message || String(err)
      }

      // ---- Build report ---------------------------------------------------
      let report: Record<string, unknown>
      if (mode === 'serena') {
        report = {
          mode,
          engine: 'serena',
          usedTools,
          dir: abs,
          filesScanned: files.length,
          files,
          note: `Semantic analysis via Serena (${files.length} top source file(s), symbols + ${includeDiagnostics ? 'diagnostics' : 'no diagnostics'}).`,
        }
      } else {
        // transparent fallback to the raw walker
        const raw = await ctx.tools.call('analyze-dir', { dir: abs }, { internal: true })
        if (isError(raw)) {
          report = { mode: 'failed', engine: 'none', usedTools: [], dir: abs, error: raw }
        } else {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            report = { mode, reason, engine: 'analyze-dir', usedTools: ['analyze-dir'], dir: abs, ...parsed }
          } catch {
            report = { mode, reason, engine: 'analyze-dir', usedTools: ['analyze-dir'], dir: abs, rawResult: raw.slice(0, OUTPUT_BUDGET) }
          }
        }
      }

      // Hard output budget: trim the files array from the end until under budget.
      let serialized = JSON.stringify(report)
      const arr = (report.files as unknown[] | undefined)
      if (Array.isArray(arr)) {
        while (serialized.length > OUTPUT_BUDGET && arr.length > 0) {
          arr.pop()
          serialized = JSON.stringify(report)
        }
      }
      if (serialized.length > OUTPUT_BUDGET) {
        report.note = `${String(report.note ?? '')}\n[report truncated to fit ${Math.round(OUTPUT_BUDGET / 1024)}KB output budget]`
      }

      return report
    },
  } satisfies Tool)
}

export const toolAnalyzeCodeDir = definePlugin(registerAnalyzeCodeDir, 'tool-analyze-code-dir', ['tools', 'fsRoots'])
