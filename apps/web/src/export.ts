import type { UIMessage } from './types'

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
