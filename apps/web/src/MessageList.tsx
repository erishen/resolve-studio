import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UIMessage } from './types'
import { CATEGORY_LABELS, CATEGORY_ORDER, type ExampleCategory, type ExampleItem } from './examples'
import { NEXT_STEP_EXAMPLES } from './examples'
import { ToolCallCard } from './ToolCallCard'

/**
 * Extract previewable .md file paths from message text.
 *
 * Matches two shapes so the web UI can offer a "preview" button:
 *  - absolute paths under a known root (/Users|/home|/tmp|/var|/opt|/usr|/etc)
 *  - relative paths containing at least one "/" (e.g. sandbox/.../foo.md,
 *    ./x.md, ../a/b.md) — the server resolves them against its cwd and serves
 *    them if within fsRoots.
 * This deliberately excludes bare cross-links like /pse/zh/... (leading "/" but
 * not a real filesystem root) and any URL containing "://" (the backend sandbox
 * would reject non-filesystem paths). Keep in sync with ToolCallCard's
 * extractMarkdownPaths.
 */
function extractMarkdownPaths(text: string): string[] {
  const paths = new Set<string>()
  const re = /((?:\/(?:Users|home|tmp|var|opt|usr|etc)|[A-Za-z0-9_.-]+)\/[^\s'"<>]*\.md)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const p = m[1]
    if (p.includes('://')) continue
    paths.add(p)
  }
  return [...paths]
}

/**
 * Extract local http(s) preview URLs (e.g. csv-analyze's report server at
 * http://127.0.0.1:PORT/data/xxx.html) so the UI can offer an iframe preview.
 * Matches URLs whose path ends in .html/.htm/.json/.png — same set the backend
 * static preview server serves.
 */
function extractPreviewUrls(text: string): string[] {
  const out = new Set<string>()
  const re = /(https?:\/\/[^\s'"<>)]+\.(?:html?|json|png|jpe?g|svg))/g
  let m
  while ((m = re.exec(text)) !== null) out.add(m[1])
  return [...out]
}

/**
 * 提取消息正文里可预览的 .md 路径。模型回复里可能用相对路径（如
 * `tasks/hot-news/articles/x.md`），后端按 cwd 解析会失败；这里用同一条消息里
 * 工具结果的**绝对路径**按文件名做匹配替换，匹配不到的相对路径直接丢弃。
 */
function extractPreviewPaths(content: string, toolResults: (string | undefined)[]): string[] {
  const candidates = extractMarkdownPaths(content)
  const absByBase = new Map<string, string>()
  for (const r of toolResults) {
    if (!r) continue
    for (const p of extractMarkdownPaths(r)) {
      if (p.startsWith('/')) absByBase.set(p.split('/').pop() ?? '', p)
    }
  }
  const out = new Set<string>()
  for (const p of candidates) {
    if (p.startsWith('/')) {
      out.add(p)
    } else {
      const abs = absByBase.get(p.split('/').pop() ?? '')
      if (abs) out.add(abs)
    }
  }
  return [...out]
}

type GroupedExamples = Record<ExampleCategory, ExampleItem[]>

interface MessageListProps {
  messages: UIMessage[]
  onDecide?: (callId: string, decision: 'approve' | 'reject') => void
  examples?: GroupedExamples
  onPickExample?: (prompt: string) => void
  onRegenerate?: () => void
  onEditFrom?: (messageId: string) => void
  onPreview?: (path: string) => void
  /** Direct re-run affordances (tool cards may ask the user to retry with different args). */
  onRetryTool?: (name: string, args: Record<string, unknown>) => void
  busy?: boolean
}

export function MessageList({
  messages,
  onDecide,
  examples,
  onPickExample,
  onRegenerate,
  onEditFrom,
  onPreview,
  onRetryTool,
  busy,
}: MessageListProps) {
  const lastIdx = messages.length - 1
  const grouped: GroupedExamples = examples ?? {
    article: [],
    'hot-news': [],
    invest: [],
    interview: [],
    crm: [],
    pse: [],
    code: [],
    library: [],
    privacy: [],
    other: [],
  }
  const hasExamples = CATEGORY_ORDER.some((c) => grouped[c].length > 0)

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="empty-state">
          <div className="empty-title">想试试这个 Agent？挑一个问题开始</div>
          {hasExamples && (
            <div className="examples-grouped">
              {CATEGORY_ORDER.map((cat) => {
                const items = grouped[cat]
                if (!items.length) return null
                return (
                  <div key={cat} className="example-category">
                    <div className="example-category-title">{CATEGORY_LABELS[cat]}</div>
                    <div className="examples">
                      {items.map((ex) => (
                        <button
                          key={ex.id}
                          type="button"
                          className="example-card"
                          onClick={() => onPickExample?.(ex.prompt)}
                        >
                          <span className="example-title">{ex.title}</span>
                          <span className="example-prompt">{ex.prompt}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {messages.map((m, idx) => {
        const isLastAssistant = idx === lastIdx && m.role === 'assistant' && !m.pending
        return (
          <div key={m.id} className={`message message-${m.role}`}>
            <div className="message-role">
              {m.role}
              {m.role === 'user' && onEditFrom && !busy && (
                <button
                  className="btn btn-sm btn-edit"
                  onClick={() => onEditFrom(m.id)}
                  title="Edit and resend from here"
                >
                  ✎
                </button>
              )}
            </div>
            <div className="message-body">
              {m.reasoning && (
                <details className="message-reasoning">
                  <summary>thinking</summary>
                  <div className="message-reasoning-body">{m.reasoning}</div>
                </details>
              )}
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="tool-calls">
                  {m.toolCalls.map((tc, i) => (
                    <ToolCallCard
                      key={tc.id ?? i}
                      name={tc.name}
                      args={tc.arguments}
                      result={tc.result}
                      ok={tc.ok}
                      gated={tc.gated}
                      awaitingApproval={tc.awaitingApproval}
                      approvalSkipped={tc.approvalSkipped}
                      decision={tc.decision}
                      durationMs={tc.durationMs}
                      progress={tc.progress}
                      onPreview={onPreview}
                      onDecide={tc.id && onDecide ? (d) => onDecide(tc.id as string, d) : undefined}
                      onRetryTool={onRetryTool}
                      retryDisabled={busy}
                    />
                  ))}
                </div>
              )}
              {m.content && (
                <div
                  className={`message-text${m.role === 'assistant' ? ' message-text-markdown' : ''}`}
                >
                  {m.role === 'assistant' ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  ) : (
                    m.content
                  )}
                </div>
              )}
              {m.role === 'assistant' &&
                onPreview &&
                (() => {
                  const results = (m.toolCalls ?? []).map((tc) => tc.result)
                  const previews = [
                    ...extractPreviewPaths(m.content, results),
                    ...extractPreviewUrls(`${m.content}\n${results.join('\n')}`),
                  ]
                  return previews.length > 0 ? (
                    <div className="message-file-links">
                      {previews.map((p) => (
                        <button
                          key={p}
                          className="btn btn-sm btn-preview"
                          onClick={() => onPreview(p)}
                          title={/^https?:/.test(p) ? '预览报告 (iframe)' : '预览文件内容'}
                        >
                          {/^https?:/.test(p) ? '🖥️' : '📄'} {p.split('/').pop()}
                        </button>
                      ))}
                    </div>
                  ) : null
                })()}
              {m.pending && !m.content && m.toolCalls?.length === 0 && (
                <div className="pending">thinking…</div>
              )}
              {isLastAssistant &&
                m.toolCalls &&
                (() => {
                  // 取最近一次成功的工具调用，映射出「下一步」示例任务
                  const done = [...m.toolCalls].reverse().find((tc) => tc.ok)
                  const next = done ? NEXT_STEP_EXAMPLES[done.name] : undefined
                  if (!next || next.length === 0 || !onPickExample) return null
                  return (
                    <div className="next-steps">
                      <div className="next-steps-title">下一步可以试试</div>
                      <div className="next-steps-list">
                        {next.map((ex) => (
                          <button
                            key={ex.id}
                            type="button"
                            className="example-card"
                            onClick={() => onPickExample(ex.prompt)}
                          >
                            <span className="example-title">{ex.title}</span>
                            <span className="example-prompt">{ex.prompt}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })()}
              {isLastAssistant && onRegenerate && (
                <button
                  className="btn btn-sm btn-regenerate"
                  onClick={onRegenerate}
                  disabled={busy}
                  title="重新生成最后一条回复"
                >
                  ↻ 重新生成
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
