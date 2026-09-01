import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UIMessage } from './types'
import { CATEGORY_LABELS, CATEGORY_ORDER, type ExampleCategory, type ExampleItem } from './examples'
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
    invest: [],
    interview: [],
    crm: [],
    pse: [],
    code: [],
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
              {m.role === 'assistant' && onPreview && extractMarkdownPaths(m.content).length > 0 && (
                <div className="message-file-links">
                  {extractMarkdownPaths(m.content).map((p) => (
                    <button
                      key={p}
                      className="btn btn-sm btn-preview"
                      onClick={() => onPreview(p)}
                      title="预览文件内容"
                    >
                      📄 {p.split('/').pop()}
                    </button>
                  ))}
                </div>
              )}
              {m.pending && !m.content && m.toolCalls?.length === 0 && (
                <div className="pending">thinking…</div>
              )}
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
