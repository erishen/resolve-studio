/**
 * Paid-provider approval gate tests.
 *
 * PSE tools expose `provider`; the paid/non-default variants (deepseek,
 * scnet-*) must hit the human-in-the-loop approval gate (`approvalWhen`) while
 * the default free run passes through ungated. pse-review fixes its provider at
 * registration (no per-call arg), so it is gated via `needsApproval` instead.
 * We only assert the gate decision here — never execute the pipelines.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { toolArticleWrite } from '../src/plugins/tools/tool-article-write.js'
import { toolInterviewQuestions } from '../src/plugins/tools/tool-interview-questions.js'
import { toolCrmTask } from '../src/plugins/tools/tool-crm-task.js'
import { toolResumeTailor } from '../src/plugins/tools/tool-resume-tailor.js'
import { toolHotNews } from '../src/plugins/tools/tool-hot-news.js'
import { toolPseReview } from '../src/plugins/tools/tool-pse-review.js'

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(toolArticleWrite)
  await root.plugin(toolInterviewQuestions)
  await root.plugin(toolCrmTask)
  await root.plugin(toolResumeTailor)
  await root.plugin(toolHotNews)
  return root
}

test('article-write free run does not require approval', async () => {
  const root = await buildContext()
  const gated = root.tools.needsApproval('article-write', { project: 'firefly-studio' })
  assert.equal(gated, false)
  await root.fiber.dispose()
})

test('article-write deepseek (paid) run requires approval', async () => {
  const root = await buildContext()
  const gated = root.tools.needsApproval('article-write', {
    project: 'firefly-studio',
    provider: 'deepseek',
  })
  assert.equal(gated, true)
  await root.fiber.dispose()
})

test('article-write approval decision works from a JSON-string args payload', async () => {
  const root = await buildContext()
  const gated = root.tools.needsApproval(
    'article-write',
    JSON.stringify({ project: 'firefly-studio', provider: 'deepseek' }),
  )
  assert.equal(gated, true)
  await root.fiber.dispose()
})

test('interview-questions: free passes, deepseek is gated', async () => {
  const root = await buildContext()
  assert.equal(root.tools.needsApproval('interview-questions', { mode: 'subject' }), false)
  assert.equal(
    root.tools.needsApproval('interview-questions', { mode: 'subject', provider: 'deepseek' }),
    true,
  )
  await root.fiber.dispose()
})

test('crm-task: free passes, deepseek is gated', async () => {
  const root = await buildContext()
  assert.equal(root.tools.needsApproval('crm-task', { task: 'crm-qa' }), false)
  assert.equal(root.tools.needsApproval('crm-task', { task: 'crm-qa', provider: 'deepseek' }), true)
  await root.fiber.dispose()
})

test('resume-tailor: free passes, deepseek/scnet-* are gated', async () => {
  const root = await buildContext()
  const base = { mode: 'customize', jd_text: 'JD' }
  assert.equal(root.tools.needsApproval('resume-tailor', base), false)
  assert.equal(root.tools.needsApproval('resume-tailor', { ...base, provider: 'deepseek' }), true)
  assert.equal(root.tools.needsApproval('resume-tailor', { ...base, provider: 'scnet-kimi' }), true)
  assert.equal(
    root.tools.needsApproval('resume-tailor', { ...base, provider: 'scnet-minimax' }),
    true,
  )
  await root.fiber.dispose()
})

// The provider string below is the framework's default gateway — a cross-process
// contract with llamaindex-pse (see the note in tool-hot-news.ts). Renaming it
// has to land in the Python framework and this tool in the same commit.
test('hot-news: default provider passes, explicit paid providers are gated', async () => {
  const root = await buildContext()
  const base = { topic: 'AI 新规落地' }
  assert.equal(root.tools.needsApproval('hot-news', base), false)
  assert.equal(root.tools.needsApproval('hot-news', { ...base, provider: 'free' }), false)
  assert.equal(root.tools.needsApproval('hot-news', { ...base, provider: 'deepseek' }), true)
  assert.equal(root.tools.needsApproval('hot-news', { ...base, provider: 'scnet-kimi' }), true)
  await root.fiber.dispose()
})

test('pse-review: free registration is ungated, deepseek registration is gated', async () => {
  const free = new Context()
  await free.plugin(ToolRegistry)
  await free.plugin(toolPseReview, { provider: 'free' })
  assert.equal(free.tools.needsApproval('pse-review', {}), false)
  await free.fiber.dispose()

  const paid = new Context()
  await paid.plugin(ToolRegistry)
  await paid.plugin(toolPseReview, { provider: 'deepseek' })
  assert.equal(paid.tools.needsApproval('pse-review', {}), true)
  await paid.fiber.dispose()
})
