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
  { id: 'tasks', name: 'tasks' },
  { id: 'jobs', name: 'jobs', config: { maxConcurrent: 3 } },
  { id: 'pse', name: '@resolve-studio/plugin-pse' },
  { id: 'sandbox', name: 'sandbox' },
  { id: 'mcp', name: 'mcp', config: { servers: [] } },
  { id: 'hello', name: '@resolve-studio/plugin-hello', config: { interval: 15000 } },
  { id: 'system-info', name: '@resolve-studio/plugin-system-info', config: { interval: 30000 } },
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
  { id: 'tool-portfolio-check', name: 'tool-portfolio-check' },
  { id: 'tool-stock-scan', name: 'tool-stock-scan' },
  { id: 'tool-csv-analyze', name: 'tool-csv-analyze' },
  { id: 'tool-product-analyze', name: 'tool-product-analyze' },
  { id: 'tool-doc-library-search', name: 'tool-doc-library-search' },
  { id: 'tool-photo-duplicates', name: 'tool-photo-duplicates' },
  { id: 'tool-video-library-list', name: 'tool-video-library-list' },
  { id: 'tool-privacy-audit', name: 'tool-privacy-audit' },
  { id: 'tool-pse-review', name: 'tool-pse-review' },
  { id: 'tool-article-write', name: 'tool-article-write' },
  { id: 'tool-resume-tailor', name: 'tool-resume-tailor' },
  { id: 'tool-interview-questions', name: 'tool-interview-questions' },
  { id: 'tool-crm-task', name: 'tool-crm-task' },
  { id: 'tool-wp-publish', name: 'tool-wp-publish' },
  { id: 'tool-crewai-publish', name: 'tool-crewai-publish' },
  { id: 'tool-crewai-discover', name: 'tool-crewai-discover' },
  { id: 'tool-hot-news', name: 'tool-hot-news' },
  { id: 'tool-hot-news-fetch', name: 'tool-hot-news-fetch' },
  { id: 'tool-hot-news-topics', name: 'tool-hot-news-topics' },
  { id: 'tool-hot-news-check', name: 'tool-hot-news-check' },
  { id: 'tool-hot-news-publish', name: 'tool-hot-news-publish' },
  { id: 'tool-system-info', name: 'tool-system-info' },
]

// LLM adapter variants.
const LLM_MOCK = { id: 'llm', name: 'llm-mock', config: { tool: 'echo' } }
// No `model` here on purpose. llm-openai resolves it as
// `config.model ?? process.env.OPENAI_MODEL ?? 'deepseek-chat'` (see
// packages/core/src/plugins/llm-openai.ts), so a manifest-level `model` would
// *win* over the operator's env var — and baking one in would hard-code a
// specific vendor/model name into a committed, public manifest. Leaving it
// unset means the deployed model is whatever the operator configures.
const LLM_OPENAI = { id: 'llm', name: 'llm-openai', config: { temperature: 0.7 } }

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
    pseReviewConfig: { provider: 'free' },
    // Read widened to the whole invest workspace so the web file-picker can
    // reach sibling projects; writes stay pinned to this repo for safety.
    // shellRoots carries one targeted exemption: crewai-pse, so the
    // "校验文章回链" example can run `make check-links` there (read-only
    // validation; its fix path is FLAGS=--dry preview only). The path is an
    // env reference resolved at load time from `.env` (gitignored), so the
    // absolute sibling path is NEVER committed; a checkout without CREWAI_PSE_DIR
    // set simply has no crewai-pse shell root.
    fs: {
      readRoots: ['../../..'],
      writeRoots: ['.'],
      shellRoots: ['.', '${CREWAI_PSE_DIR}'],
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
