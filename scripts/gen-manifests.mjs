#!/usr/bin/env node
/**
 * gen-manifests.mjs — single source of truth for the four Cordis composition
 * manifests (cordis.yml / cordis.openai.yml / cordis.web.yml /
 * cordis.openai.web.yml).
 *
 * The harness ships four near-identical manifests that differ only along a 2×2
 * matrix: { mock | OpenAI LLM } × { cli | web-server }. `cli` and `web` are
 * mutually exclusive — the CLI builds add `cli-chat`; the Web builds add the
 * `web-server` bridge (and, for the OpenAI+Web build, an `fs:` sandbox block
 * plus a `tool-pse-review` provider). Before this generator, adding a tool meant
 * editing all four files by hand — a recipe for drift (see docs/TODO.md
 * "4 份 yml 重复条目漂移"). Every composition is now derived from BASE_PLUGINS
 * plus the per-variant deltas below, so one edit here updates all four.
 *
 * Run:  node scripts/gen-manifests.mjs   (writes the 4 files)
 *       make manifests
 *
 * The generated files carry an "AUTO-GENERATED" header; edit THIS file, not the
 * .yml outputs. `tests/manifests.test.ts` fails if a committed .yml drifts from
 * what this generator produces.
 *
 * The emitter below is intentionally dependency-free (the `yaml` package lives
 * under packages/core and is not resolvable from this repo-root script), and
 * produces stable, diff-friendly output.
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// --- Single source of truth -------------------------------------------------
// Plugins present in EVERY composition, in load order. The `llm` and `web`
// entries are injected per-variant (see build() below), so they are NOT listed
// here.
const BASE_PLUGINS = [
  { id: 'tools', name: 'tools' },
  { id: 'agent', name: 'agent' },
  { id: 'fastpath', name: 'fastpath' },
  { id: 'approval', name: 'approval' },
  { id: 'usage', name: 'usage' },
  { id: 'skills', name: 'skills' },
  { id: 'mcp', name: 'mcp', config: { servers: [] } },
  { id: 'hello', name: '@agent-harness/plugin-hello', config: { interval: 15000 } },
  { id: 'tool-hello', name: 'tool-hello' },
  { id: 'tool-echo', name: 'tool-echo' },
  { id: 'tool-calculator', name: 'tool-calculator' },
  { id: 'tool-read-file', name: 'tool-read-file' },
  { id: 'tool-analyze-dir', name: 'tool-analyze-dir' },
  { id: 'tool-analyze-code-dir', name: 'tool-analyze-code-dir' },
  { id: 'tool-write-file', name: 'tool-write-file' },
  { id: 'tool-shell', name: 'tool-shell' },
  { id: 'tool-browser', name: 'tool-browser' },
  { id: 'tool-pick-post', name: 'tool-pick-post' },
  { id: 'tool-skill-run', name: 'tool-skill-run' },
  { id: 'tool-portfolio-summary', name: 'tool-portfolio-summary' },
  { id: 'tool-pse-review', name: 'tool-pse-review' },
]

// LLM adapter variants.
const LLM_MOCK = { id: 'llm', name: 'llm-mock', config: { tool: 'echo' } }
const LLM_OPENAI = { id: 'llm', name: 'llm-openai', config: { model: 'deepseek-chat', temperature: 0.7 } }

// Interface variant — `cli` and `web` are mutually exclusive.
const CLI = { id: 'cli', name: 'cli-chat' }
const WEB = { id: 'web', name: 'web-server', config: { host: '127.0.0.1', port: 8787 } }

/**
 * Build one composition.
 * @param llm     the LLM adapter entry (mock or openai)
 * @param iface   the interface entry: `CLI` or `WEB` (mutually exclusive)
 * @param pseReviewConfig  override tool-pse-review's config (openai.web only)
 * @param fs      optional top-level `fs:` sandbox-roots block
 */
function build({ llm, iface, pseReviewConfig, fs } = {}) {
  const plugins = BASE_PLUGINS.map((p) =>
    p.name === 'tool-pse-review' && pseReviewConfig ? { ...p, config: pseReviewConfig } : p,
  )
  // Keep the original ordering: `llm` sits right after `tool-hello`, and the
  // interface plugin (cli/web) is always last.
  const idx = plugins.findIndex((p) => p.id === 'tool-hello')
  plugins.splice(idx + 1, 0, llm)
  plugins.push(iface)

  const doc = fs ? { fs, plugins } : { plugins }
  return doc
}

const VARIANTS = {
  'cordis.yml': build({ llm: LLM_MOCK, iface: CLI }),
  'cordis.openai.yml': build({ llm: LLM_OPENAI, iface: CLI }),
  'cordis.web.yml': build({ llm: LLM_MOCK, iface: WEB }),
  'cordis.openai.web.yml': build({
    llm: LLM_OPENAI,
    iface: WEB,
    pseReviewConfig: { provider: 'agnes' },
    // Read widened to the whole invest workspace so the web file-picker can
    // reach sibling projects; writes/shell stay pinned to this repo for safety.
    fs: {
      readRoots: ['WORKSPACE'],
      writeRoots: ['WORKSPACE/agent-harness'],
      shellRoots: ['WORKSPACE/agent-harness'],
    },
  }),
}

// --- Dependency-free YAML emitter (stable, diff-friendly) -------------------

function emitScalar(v) {
  if (typeof v === 'number') return String(v)
  const s = String(v)
  const needsQuote =
    s === '' ||
    /^\s/.test(s) ||
    /\s$/.test(s) ||
    /[:#]/.test(s) || // colon/hash mid-string would break parsing
    /^[-?!:>|@`*&%]/.test(s) || // leading YAML indicator
    /^true$|^false$|^null$|^~$/i.test(s) ||
    /^[0-9]/.test(s) // could be parsed as a number
  return needsQuote ? `'${s.replace(/'/g, "''")}'` : s
}

function emitValue(v, indent) {
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    const pad = ' '.repeat(indent)
    return '\n' + v.map((item) => `${pad}- ${emitScalar(item)}`).join('\n')
  }
  if (v && typeof v === 'object') {
    const pad = ' '.repeat(indent)
    const lines = Object.entries(v).map(([k, val]) => {
      if (Array.isArray(val)) {
        if (val.length === 0) return `${pad}${k}: []`
        const inner = val.map((it) => `${pad}  - ${emitScalar(it)}`).join('\n')
        return `${pad}${k}:\n${inner}`
      }
      return `${pad}${k}: ${emitScalar(val)}`
    })
    return '\n' + lines.join('\n')
  }
  return emitScalar(v)
}

function emitPlugin(p) {
  let s = `  - id: ${emitScalar(p.id)}\n    name: ${emitScalar(p.name)}`
  if (p.config) s += `\n    config:${emitValue(p.config, 6)}`
  return s
}

function emitDoc(doc) {
  let s = ''
  if (doc.fs) s += `fs:${emitValue(doc.fs, 2)}\n`
  s += 'plugins:\n' + doc.plugins.map(emitPlugin).join('\n')
  return s
}

const HEADER = `# AUTO-GENERATED by scripts/gen-manifests.mjs — DO NOT EDIT HERE.
# Single source of truth lives in that script; run \`make manifests\` to regenerate.
# MCP servers: tools are registered as <id>:<tool> and default to needing human
# approval unless a server opts out via its \`approval\` policy.
`

/** Return a map of manifest filename → full file content (for tests + CLI). */
export function generateAll() {
  const out = {}
  for (const [file, doc] of Object.entries(VARIANTS)) {
    out[file] = HEADER + emitDoc(doc) + '\n'
  }
  return out
}

// CLI: write the files when run directly.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [file, content] of Object.entries(generateAll())) {
    writeFileSync(join(ROOT, file), content)
    console.log('wrote', file)
  }
}
