/**
 * PSE orchestrator tests — verify that enabling PSE dispatches a real
 * Planner → Specialist → Evaluator multi-agent flow instead of a flat loop.
 *
 * Each role is addressed with its own SOUL.md system prompt. A recording LLM
 * captures the per-role system prompts so tests can assert the orchestration
 * actually happened (not just a single combined "三角色" prose block).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { AgentService } from '../src/services/agent.js'
import { FastPathService } from '../src/services/fastpath.js'
import { ApprovalService } from '../src/services/approval.js'
import { UsageService } from '../src/services/usage.js'
import { LlmService } from '../src/services/llm.js'
import { skills } from '../src/plugins/skills.js'
import { toolEcho } from '../src/plugins/tools/tool-echo.js'
import pse from '@resolve-studio/plugin-pse'
import type { ChatMessage, ChatResponse } from '../src/types.js'

const SOULS = join(import.meta.dirname, 'fixtures', 'souls')

/** Captures every system prompt it sees and lets tests control the verdict. */
function makeRecordingLlm(
  verdict = 'PASS — 校验通过',
  byPhase: { planner?: string; evaluator?: string } = {},
) {
  const prompts: string[] = []
  const calls: string[] = []
  class RecordingLlm extends LlmService {
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      for (const m of messages) {
        if (m.role === 'system' && typeof m.content === 'string') prompts.push(m.content)
        if (m.role === 'user' && typeof m.content === 'string') calls.push(m.content)
      }
      const sys = messages.find((m) => m.role === 'system')
      const soul = typeof sys?.content === 'string' ? sys.content : ''
      if (soul.includes('Planner') && byPhase.planner !== undefined) {
        return { content: byPhase.planner }
      }
      if (soul.includes('Evaluator') && byPhase.evaluator !== undefined) {
        return { content: byPhase.evaluator }
      }
      return { content: verdict }
    }
    async models() {
      return []
    }
  }
  return { cls: RecordingLlm, prompts, calls }
}

async function buildRoot(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  // Enable PSE so the orchestrator runs.
  await root.plugin(pse, { enabled: true, soulsDir: SOULS })
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(UsageService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  return root
}

test('PSE on runs Planner, Specialist, and Evaluator as separate role prompts', async () => {
  const root = await buildRoot()
  const { cls, prompts } = makeRecordingLlm('PASS — 校验通过')
  await root.plugin(cls)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '写一篇热点分析报告' }],
    // Even though the global flag is on, force it here to make intent explicit.
    pse: true,
  })

  const all = prompts.join('\n')
  assert.match(all, /planner soul/)
  assert.match(all, /specialist soul/)
  assert.match(all, /evaluator soul/)
  // No single "combined" role prose should be injected — each role got its own.
  assert.ok(!all.includes('PSE 三角色工作流（已启用）'))
  assert.equal(typeof answer, 'string')

  await root.fiber.dispose()
})

test('PSE Evaluator PASS returns the Specialist result without retrying', async () => {
  const root = await buildRoot()
  const { cls, prompts } = makeRecordingLlm('PASS — 校验通过')
  await root.plugin(cls)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '生成报表' }],
    pse: true,
  })

  // Planner prompt appears exactly once (no retry cycle on PASS).
  const plannerPrompts = prompts.filter((p) => p.includes('planner soul'))
  assert.equal(plannerPrompts.length, 1)
  assert.ok(answer.length > 0)

  await root.fiber.dispose()
})

test('PSE Evaluator FAIL retries the cycle up to the cap with feedback', async () => {
  const root = await buildRoot()
  // Always FAIL → orchestrator should run the full Planner→Evaluator cycle
  // MAX retries + 1 = 3 times, preserving the last Specialist result.
  const { cls, prompts } = makeRecordingLlm('FAIL — 结果不符合规范')
  await root.plugin(cls)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '生成合规文案' }],
    pse: true,
  })

  const plannerPrompts = prompts.filter((p) => p.includes('planner soul'))
  assert.equal(plannerPrompts.length, 3)
  assert.match(answer, /Evaluator 经过 3 轮评审未给出 PASS/)

  await root.fiber.dispose()
})

test('PSE Evaluator PARTIAL delivers the result without re-running the pipeline', async () => {
  const root = await buildRoot()
  // PARTIAL = core ACs met, artifacts exist — no expensive retry. The
  // reviewer's notes should be surfaced, and the planner runs exactly once.
  const partial = 'PARTIAL: 文案已生成，但汇报未明确说明清单字段完整性。'
  const { cls, prompts } = makeRecordingLlm('PASS — default', {
    evaluator: partial,
  })
  await root.plugin(cls)

  const answer = await root.agent.run({
    messages: [{ role: 'user', content: '生成报表' }],
    pse: true,
  })

  const plannerPrompts = prompts.filter((p) => p.includes('planner soul'))
  assert.equal(plannerPrompts.length, 1, 'a PARTIAL must not trigger a full pipeline retry')
  assert.match(answer, /PARTIAL/, 'reviewer notes should be surfaced in the delivered answer')

  await root.fiber.dispose()
})

test('PSE off still runs the flat loop (no role prompts)', async () => {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(pse, { enabled: false, soulsDir: SOULS })
  await root.plugin(AgentService)
  await root.plugin(FastPathService)
  await root.plugin(ApprovalService)
  await root.plugin(skills, { dir: '../../skills' })
  await root.plugin(toolEcho)
  const { cls, prompts } = makeRecordingLlm('PASS — 校验通过')
  await root.plugin(cls)

  await root.agent.run({
    messages: [{ role: 'user', content: '你好' }],
    pse: false,
  })

  const all = prompts.join('\n')
  assert.ok(!all.includes('planner soul'))
  assert.ok(!all.includes('specialist soul'))
  assert.ok(!all.includes('evaluator soul'))

  await root.fiber.dispose()
})

test('PSE sanitizes malformed XML tool-call syntax from the Planner so it does not leak to the Specialist', async () => {
  const root = await buildRoot()
  // The Planner hallucinates a pseudo tool-call (`delegate_specialist` with
  // broken `<parameter>` tags) instead of a clean plan. The orchestrator must
  // strip the XML so the Specialist's system prompt doesn't receive tag soup.
  const garbage =
    '<tool_call> <parameter=task> 读取 sample_sales_report.md </parameter> ' +
    '<parameter=acceptance_criteria> 返回完整内容 </parameter> </parameter> </parameter>'
  const { cls, prompts } = makeRecordingLlm('PASS — ok', {
    planner: garbage,
  })
  await root.plugin(cls)

  await root.agent.run({
    messages: [{ role: 'user', content: '生成分析报告' }],
    pse: true,
  })

  const specialistPrompts = prompts.filter((p) => p.includes('specialist soul'))
  assert.ok(specialistPrompts.length >= 1)
  assert.ok(!specialistPrompts[0].includes('</parameter>'), 'XML tag soup must not reach the Specialist')
  assert.ok(!specialistPrompts[0].includes('<tool_call>'), 'pseudo tool-call tag must not reach the Specialist')

  await root.fiber.dispose()
})

test('PSE treats an Evaluator PASS wrapped in a markdown code fence as PASS (no retry)', async () => {
  const root = await buildRoot()
  // The model returned the verdict inside a ``` fence — the first line is the
  // fence, not "PASS". The orchestrator must strip the fence so it stops
  // instead of re-running the whole (expensive) pipeline.
  const fencedPass = '```\nPASS: 全部验收标准均已达成。\n```\n\n核验依据略。'
  const { cls, prompts } = makeRecordingLlm('PASS — default', {
    evaluator: fencedPass,
  })
  await root.plugin(cls)

  await root.agent.run({
    messages: [{ role: 'user', content: '生成报表' }],
    pse: true,
  })

  const plannerPrompts = prompts.filter((p) => p.includes('planner soul'))
  assert.equal(plannerPrompts.length, 1, 'a fenced PASS must not trigger a retry cycle')

  await root.fiber.dispose()
})
