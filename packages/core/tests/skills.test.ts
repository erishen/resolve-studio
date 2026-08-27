/**
 * Skills service tests: indexing the skills/ directory, reading SKILL.md,
 * frontmatter parsing, and the prompt-fragment generation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { skills } from '../src/plugins/skills.js'

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(skills, { dir: '../../../resolve-skills/skills' })
  return root
}

test('indexes skill folders with frontmatter name and description', async () => {
  const root = await buildContext()
  const list = await root.skills.list()
  const codeReview = list.find((s) => s.name === 'code-review')
  assert.ok(codeReview, 'expected code-review to be indexed')
  assert.ok(codeReview.description.includes('审查'), 'expected Chinese description')
  assert.ok(
    list.some((s) => s.name === 'post-comment'),
    'expected post-comment too',
  )
  await root.fiber.dispose()
})

test('read returns the SKILL.md content', async () => {
  const root = await buildContext()
  const md = await root.skills.read('code-review')
  assert.ok(md && md.includes('# Code Review'), 'expected SKILL.md body')
  await root.fiber.dispose()
})

test('missing skills return null / are skipped', async () => {
  const root = await buildContext()
  assert.equal(await root.skills.read('no-such-skill'), null)
  const list = await root.skills.list()
  assert.ok(!list.some((s) => s.name === 'no-such-skill'))
  await root.fiber.dispose()
})

test('indexText builds a prompt fragment naming each skill', async () => {
  const root = await buildContext()
  const text = await root.skills.indexText()
  assert.ok(text.includes('可用技能'), 'expected header line')
  assert.ok(text.includes('code-review'))
  assert.ok(text.includes('read-file'), 'expected usage hint')
  await root.fiber.dispose()
})

test('indexText is empty when no skills exist', async () => {
  const root = new Context()
  await root.plugin(skills, { dir: './no-such-dir' })
  assert.equal(await root.skills.indexText(), '')
  await root.fiber.dispose()
})
