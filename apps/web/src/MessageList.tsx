import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UIMessage } from './App'
import type { ExampleItem } from './examples'
import { ToolCallCard } from './ToolCallCard'

interface MessageListProps {
  messages: UIMessage[]
  onDecide?: (callId: string, decision: 'approve' | 'reject') => void
  examples?: ExampleItem[]
  onPickExample?: (prompt: string) => void
}

export function MessageList({ messages, onDecide, examples = [], onPickExample }: MessageListProps) {
  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="empty-state">
          <div className="empty-title">想试试这个 Agent？挑一个问题开始</div>
          <div className="examples">
            {examples.map((ex) => (
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
      )}
      {messages.map((m) => (
        <div key={m.id} className={`message message-${m.role}`}>
          <div className="message-role">{m.role}</div>
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
                    onDecide={
                      tc.id && onDecide
                        ? (d) => onDecide(tc.id as string, d)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
            {m.content && (
              <div className={`message-text${m.role === 'assistant' ? ' message-text-markdown' : ''}`}>
                {m.role === 'assistant' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                ) : (
                  m.content
                )}
              </div>
            )}
            {m.pending && !m.content && m.toolCalls?.length === 0 && (
              <div className="pending">thinking…</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
