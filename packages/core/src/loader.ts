/**
 * Config-driven loader for Cordis plugin manifests.
 *
 * DeepSeek Harness (dsh) and this scaffold both build their runtime from a
 * Cordis plugin manifest. A manifest entry has `id` / `name` / `config`:
 *
 *   - `name` may be either a **local short name** resolved against the bundled
 *     {@link PLUGINS} registry (`llm-mock`, `agent`, …), or an **npm package
 *     name** (e.g. `@cordisjs/plugin-timer`, `@deepseek-ai/cordis-plugin-hmr`).
 *     The latter are pure-Cordis plugins shared across the ecosystem and need
 *     no dsh-* service layer — they load the same way the official
 *     `@cordisjs/plugin-loader` resolves them: by dynamic `import(name)`.
 *
 *   - Two manifest formats are accepted:
 *       (a) the flat `plugins: [...]` shape used by `cordis.yml`, and
 *       (b) dsh's `cordis.patch.yml` shape with a top-level `- insert:` block
 *          whose rows carry `name` / `config` (and optional `id`).
 *
 * This keeps the demo self-contained while remaining wire-compatible with the
 * broader Cordis plugin ecosystem: any plugin that only depends on Cordis'
 * standard `Context` / `Service` / `events` API can be dropped in by package
 * name, no code changes required.
 */

import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import type { Context, Plugin } from 'cordis'
import { PLUGINS } from './plugins/registry.js'

interface Entry {
  id?: string
  name: string
  config?: Record<string, unknown>
  disabled?: boolean
}

interface FlatFile {
  plugins?: Entry[]
  /** Optional top-level `fs:` block customizing the filesystem sandbox roots. */
  fs?: Record<string, unknown>
}

interface PatchFile {
  insert?: Entry[]
}

type ManifestDoc = FlatFile & PatchFile & { fs?: Record<string, unknown> }

/** Read and normalize a manifest into a flat entry list plus the `fs` config. */
function readManifest(path: string): { entries: Entry[]; fs?: Record<string, unknown> } {
  const raw = readFileSync(path, 'utf8')
  const doc: unknown = parse(raw)
  // dsh cordis.patch.yml is a YAML *list* of patch ops; the `insert` op carries
  // the plugin rows. A bare list is treated as a single insert block.
  if (Array.isArray(doc)) {
    const rows: Entry[] = []
    for (const op of doc) {
      if (op && typeof op === 'object' && Array.isArray((op as PatchFile).insert)) {
        rows.push(...(op as PatchFile).insert!)
      }
    }
    if (rows.length) return { entries: rows }
    // No `insert` ops — treat each list item as a plugin entry itself.
    return { entries: doc as Entry[] }
  }
  const manifest = doc as ManifestDoc
  // Flat `plugins: [...]` shape (cordis.yml).
  if (Array.isArray(manifest.insert)) return { entries: manifest.insert, fs: manifest.fs }
  return { entries: manifest.plugins ?? [], fs: manifest.fs }
}

/**
 * Resolve a plugin `name` to a Cordis plugin value.
 *
 * Tries, in order:
 *   1. the local {@link PLUGINS} registry (short names),
 *   2. a dynamic `import()` of the name as an npm package (pure-Cordis plugins
 *      published to the ecosystem). The imported module is expected to export a
 *      Cordis plugin at `.default` or `.plugin`, falling back to the namespace.
 */
async function resolvePlugin(name: string): Promise<Plugin | null> {
  const local = PLUGINS[name]
  if (local) return local

  try {
    const mod = (await import(name)) as {
      default?: Plugin
      plugin?: Plugin
      [key: string]: unknown
    }
    const plugin = mod.default ?? mod.plugin
    if (plugin) return plugin
    // Fallback: first export that looks like a plugin (has apply/name).
    for (const value of Object.values(mod)) {
      if (value && typeof value === 'object' && ('apply' in value || 'name' in value)) {
        return value as Plugin
      }
    }
  } catch (err) {
    return null
  }
  return null
}

/**
 * Load plugins described by a Cordis manifest into `ctx`.
 *
 * @param ctx — the root Cordis context.
 * @param path — path to the YAML manifest (default `./cordis.yml`).
 */
export async function loadConfig(ctx: Context, path = './cordis.yml'): Promise<void> {
  const { entries, fs } = readManifest(path)
  const log = ctx.logger('loader')

  // Always register the filesystem-sandbox service first so the fs tools and the
  // web bridge can inject it. Its config (readRoots/writeRoots/shellRoots) comes
  // from the manifest's top-level `fs:` key; when omitted it falls back to
  // cwd-based defaults, preserving the previous behavior across all compositions.
  await ctx.registry.plugin(PLUGINS['fs-roots'], fs ?? {})

  for (const entry of entries) {
    if (entry.disabled) {
      log.debug('skip disabled plugin %s', entry.name)
      continue
    }
    const plugin = await resolvePlugin(entry.name)
    if (!plugin) {
      log.warn('unknown plugin "%s" — skipping', entry.name)
      continue
    }
    log.info('load %s', entry.name)
    await ctx.registry.plugin(plugin, entry.config ?? {})
  }
}
