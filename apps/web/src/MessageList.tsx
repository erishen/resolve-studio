import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UIMessage } from './types'
import { CATEGORY_LABELS, CATEGORY_ORDER, type ExampleCategory, type ExampleItem } from './examples'
import { ToolCallCard } from './ToolCallCard'

/** Extract absolute .md file paths from text for preview buttons. */
function extractMarkdownPaths(text: string): string[] {
  const paths = new Set<string>()
  const re = /(\/[^\s'"<>，。、；：]+\.md)/g
  let m
  while ((m = re.exec(text)) !== null) {
    paths.add(m[1])
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
                      decision={tc.decision}
                      durationMs={tc.durationMs}
                      progress={tc.progress}
                      onPreview={onPreview}
                      onDecide={tc.id && onDecide ? (d) => onDecide(tc.id as string, d) : undefined}
                    />
                  ))}
                </div>
              )}
              {m.content && (
                <div
                  className={`message-text${m.role === 'assistant' ? ' message-text-markdown' : ''}`}
                >
                  {m.role === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
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
