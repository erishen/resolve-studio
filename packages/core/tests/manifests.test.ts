/**
 * Regression test: the four committed Cordis manifests (cordis*.yml) must stay
 * in sync with their single source of truth, scripts/gen-manifests.mjs.
 *
 * Before the generator, adding a tool meant hand-editing all four files — a
 * recipe for drift (see docs/TODO.md). Now every manifest is derived from one
 * place; if someone edits a .yml by hand (or forgets to re-run `make
 * manifests`), this test fails and names the drifted file.
 *
 * We compare PARSED structures, not raw text: the generator emits slightly
 * different (but semantically identical) YAML than the original hand-written
 * files — e.g. it quotes `host: '127.0.0.1'` and expands flow sequences to block
 * form. A raw-text diff would false-positive on those cosmetic differences, so
 * we normalize through a YAML parser and compare the actual plugin graph.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { generateAll } from '../../../scripts/gen-manifests.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Normalize a parsed manifest into a comparable shape (plugin graph + fs). */
function normalize(doc: unknown): unknown {
  const d = doc as { plugins?: any[]; fs?: unknown }
  return {
    fs: d.fs ?? null,
    plugins: (d.plugins ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      config: p.config ?? null,
    })),
  }
}

test('committed cordis*.yml files match the generator (no drift)', () => {
  const generated = generateAll()
  const drifted: string[] = []
  const reasons: string[] = []
  for (const [file, content] of Object.entries(generated)) {
    const onDisk = readFileSync(join(ROOT, file), 'utf8')
    const a = normalize(parseYaml(onDisk))
    const b = normalize(parseYaml(content))
    try {
      assert.deepEqual(a, b)
    } catch (err) {
      drifted.push(file)
      reasons.push(`${file}: ${(err as Error).message}`)
    }
  }
  assert.deepEqual(
    drifted,
    [],
    `these manifests drifted from scripts/gen-manifests.mjs — run \`make manifests\`:\n${reasons.join('\n')}`,
  )
})

test('every variant registers 23 plugins incl. the interface entry (cli|web)', () => {
  const generated = generateAll()
  for (const [file, content] of Object.entries(generated)) {
    const doc = parseYaml(content) as { plugins: { id: string }[] }
    const ids = doc.plugins.map((p) => p.id)
    assert.equal(ids.length, 23, `${file} should have 23 plugins, got ${ids.length}`)
    // cli-chat for CLI builds, web-server for Web builds — never both, never neither.
    const hasCli = ids.includes('cli')
    const hasWeb = ids.includes('web')
    assert.ok(hasCli !== hasWeb, `${file} must have exactly one of {cli, web} (cli=${hasCli}, web=${hasWeb})`)
  }
})
