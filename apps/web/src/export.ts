import type { JobRecord, UIMessage } from './types'

/** Convert a conversation to Markdown for export / clipboard. */
export function messagesToMarkdown(messages: UIMessage[], title?: string): string {
  const lines: string[] = []
  if (title) lines.push(`# ${title}`, '')
  for (const m of messages) {
    const role = m.role === 'user' ? '👤 User' : '🤖 Assistant'
    lines.push(`## ${role}`, '')
    if (m.reasoning) {
      lines.push('> **Thinking**', '', `> ${m.reasoning.replace(/\n/g, '\n> ')}`, '')
    }
    if (m.content) {
      lines.push(m.content, '')
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const status =
          tc.decision === 'reject' ? '❌ rejected' : tc.result ? '✅ done' : '⏳ pending'
        lines.push(`**Tool:** \`${tc.name}\` — ${status}`, '')
        lines.push('```json', JSON.stringify(tc.arguments, null, 2), '```', '')
        if (tc.result) {
          lines.push('**Result:**', '', '```', tc.result, '```', '')
        }
      }
    }
    lines.push('---', '')
  }
  return lines.join('\n')
}

/** Trigger a browser download for text content. */
export function downloadText(filename: string, content: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Copy text to clipboard, falling back to a textarea hack for older browsers. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      return true
    } catch {
      return false
    } finally {
      document.body.removeChild(ta)
    }
  }
}

/** Derive a safe filename from a session title. */
export function safeFilename(title: string, ext: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'conversation'}.${ext}`
}

/**
 * Format a background job's record as a shareable diagnostic log.
 *
 * Success runs: only a compact tool-call/result summary is emitted (tool name
 * + ok/fail + duration), keeping the paste short and readable.
 * Failed / cancelled / error runs: full detail is included (args, result body,
 * error messages, final answer) so the diagnostic context is complete.
 *
 * Per-token `delta`/`reasoning` events duplicate the `step` text and are
 * skipped; oversized tool results are truncated to stay paste-friendly.
 */
export function jobToLog(job: JobRecord): string {
  const lines: string[] = []
  const time = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '-')
  const isProblem = job.status === 'failed' || job.status === 'cancelled' || !!job.error

  lines.push(`【任务】${job.name}`)
  lines.push(`id: ${job.id} · 状态: ${job.status}`)
  lines.push(
    `时间: 创建 ${time(job.createdAt)} / 开始 ${time(job.startedAt)} / 结束 ${time(job.finishedAt)}`,
  )
  const extras: string[] = []
  if (job.taskId) extras.push(`任务模式: ${job.taskId}`)
  if (job.model) extras.push(`模型: ${job.model}`)
  if (job.workspace) extras.push(`工作区: …/${job.workspace.split('/').slice(-3).join('/')}`)
  if (extras.length) lines.push(extras.join(' · '))
  if (job.usage) {
    lines.push(
      `用量: ${(job.usage.prompt + job.usage.completion).toLocaleString()} tok (prompt ${job.usage.prompt.toLocaleString()} / completion ${job.usage.completion.toLocaleString()}) · ¥${job.usage.cost.toFixed(4)}`,
    )
  }
  if (job.error) lines.push(`错误: ${job.error}`)
  lines.push('')
  lines.push('--- 提示词 ---')
  lines.push(job.prompt)
  lines.push('')

  const MAX_RESULT = 3000
  const truncate = (s: string, limit: number) =>
    s.length > limit ? `${s.slice(0, limit)}\n…[截断 ${s.length - limit} 字符]` : s

  if (isProblem) {
    // ---- failed / cancelled / error: full event dump ----
    lines.push(`--- 事件日志 (${job.events.length}) ---`)
    for (const ev of job.events) {
      switch (ev.type) {
        case 'step': {
          const text = (ev.step.message.content ?? '').trim()
          if (text) lines.push(`[${ev.seq}] step: ${text}`)
          break
        }
        case 'tool-call': {
          lines.push(`[${ev.seq}] 调用: ${ev.call.name}`)
          lines.push(truncate(JSON.stringify(ev.call.arguments, null, 2), 1000))
          break
        }
        case 'tool-result': {
          lines.push(`[${ev.seq}] 结果: ${ev.call.name} ${ev.ok ? '✓' : '✗'} ${ev.durationMs}ms`)
          lines.push(truncate(ev.result, MAX_RESULT))
          break
        }
        case 'tool-progress':
          lines.push(`[${ev.seq}] 进度: ${ev.chunk}`)
          break
        case 'approval-request':
          lines.push(`[${ev.seq}] 审批: ${ev.call.name}`)
          break
        case 'usage':
          lines.push(
            `[${ev.seq}] 用量: ${ev.record.model} prompt=${ev.record.promptTokens} completion=${ev.record.completionTokens} ¥${ev.record.cost.toFixed(4)}`,
          )
          break
        case 'done':
          lines.push(`[${ev.seq}] 完成: ${ev.answer}`)
          break
        default:
          break
      }
    }
  } else {
    // ---- success: compact tool summary only ----
    const calls = job.events.filter((e) => e.type === 'tool-call')
    const results = new Map(
      job.events.filter((e) => e.type === 'tool-result').map((e) => [e.call.id, e]),
    )
    const done = job.events.find((e) => e.type === 'done')
    if (calls.length === 0) {
      lines.push('--- 执行摘要（未调用工具，模型仅回复） ---')
    } else {
      lines.push(`--- 执行摘要 (${calls.length} 步) ---`)
      for (const call of calls) {
        const r = results.get(call.call.id)
        const ok = r?.ok === false ? ' ✗' : ''
        const dur = r ? ` ${r.durationMs}ms` : ''
        lines.push(`• ${call.call.name}${ok}${dur}`)
        if (r && !r.ok) {
          lines.push(`  args: ${JSON.stringify(call.call.arguments)}`)
          lines.push(`  error: ${r.result}`)
        }
      }
    }
    // Prefer done event; fall back to the last step's text content (models
    // sometimes emit an empty string on `done` but carry the actual text
    // in the preceding step).
    const answer =
      done?.answer ||
      [...job.events]
        .reverse()
        .find((e) => e.type === 'step')
        ?.step.message.content?.trim() ||
      ''
    if (answer) lines.push('', answer)
  }
  return lines.join('\n')
}
