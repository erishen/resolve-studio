import { useState } from 'react'

interface ToolCallCardProps {
  name: string
  args: string | Record<string, unknown>
  result?: string
  ok?: boolean
  /** True if the tool is flagged as needing human approval. */
  gated?: boolean
  /** True while the backend is waiting for a human decision. */
  awaitingApproval?: boolean
  /** The human's decision, once made. */
  decision?: 'approve' | 'reject'
  /** Execution time in milliseconds. */
  durationMs?: number
  /** Streaming progress log for long-running tools. */
  progress?: string
  onDecide?: (decision: 'approve' | 'reject') => void
  onPreview?: (path: string) => void
}

function renderArgs(args: string | Record<string, unknown>): string {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** Collapsible <pre>: shows first MAX_LINES by default, toggle to expand. */
function CollapsiblePre({ text, maxLines = 8 }: { text: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const needsCollapse = lines.length > maxLines
  const display = expanded ? text : lines.slice(0, maxLines).join('\n')
  return (
    <div className="collapsible-pre">
      <pre className={expanded ? '' : 'pre-collapsed'}>{display}</pre>
      {needsCollapse && (
        <button
          className="btn btn-sm btn-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起 ▲' : `展开全部 (${lines.length} 行) ▼`}
        </button>
      )}
    </div>
  )
}

/** If `result` is a saved screenshot path, return its serving URL; else null. */
function screenshotUrl(result?: string): string | null {
  if (!result) return null
  const m = result.match(/(\S+\.png)/i)
  if (!m) return null
  const file = m[1].split(/[\\/]/).pop()
  if (!file) return null
  return `/api/screenshots/${encodeURIComponent(file)}`
}

/** Extract absolute .md file paths from a tool result for preview. */
function extractMarkdownPaths(result?: string): string[] {
  if (!result) return []
  const paths = new Set<string>()
  // Match absolute paths ending in .md. Require at least 3 path segments
  // (e.g. /Users/.../file.md) to avoid matching URL fragments like /foo.md.
  const re = /(\/(?:Users|home|tmp|var|opt|usr|etc)[^\s'"<>]+\.md)/g
  let m
  while ((m = re.exec(result)) !== null) {
    paths.add(m[1])
  }
  return [...paths]
}

/**
 * Composite tools (e.g. analyze-code-dir) run their work through *other*
 * tools internally; those sub-calls are invisible to the UI because they happen
 * inside one tool execution. They embed engine + usedTools metadata in their
 * JSON result so the card can surface "what it actually delegated to".
 */
function parseEngineInfo(result?: string): { engine?: string; usedTools?: string[] } | null {
  if (!result) return null
  try {
    const obj = JSON.parse(result) as Record<string, unknown>
    if (obj && typeof obj === 'object') {
      const engine = typeof obj.engine === 'string' ? obj.engine : undefined
      const usedTools = Array.isArray(obj.usedTools)
        ? (obj.usedTools.filter((x) => typeof x === 'string') as string[])
        : undefined
      if (engine || (usedTools && usedTools.length)) return { engine, usedTools }
    }
  } catch {
    /* result is not JSON, or carries no engine metadata */
  }
  return null
}

export function ToolCallCard({
  name,
  args,
  result,
  ok,
  gated,
  awaitingApproval,
  decision,
  durationMs,
  progress,
  onDecide,
  onPreview,
}: ToolCallCardProps) {
  const resolved = ok === undefined ? 'pending' : ok ? 'ok' : 'error'
  const shot = screenshotUrl(result)
  const engineInfo = parseEngineInfo(result)
  const mdPaths = extractMarkdownPaths(result)
  const durationLabel =
    durationMs !== undefined
      ? durationMs < 1000
        ? `${Math.round(durationMs)}ms`
        : `${(durationMs / 1000).toFixed(1)}s`
      : null
  return (
    <div className={`tool-card tool-${resolved}${gated ? ' tool-card-gated' : ''}`}>
      <div className="tool-head">
        <span className="tool-name">
          {name}
          {gated ? ' ⚠' : ''}
        </span>
        <span className="tool-head-right">
          {durationLabel && <span className="tool-duration">{durationLabel}</span>}
          <span className={`tool-badge tool-badge-${resolved}`}>
            {awaitingApproval ? 'awaiting approval' : (decision ?? resolved)}
          </span>
        </span>
      </div>
      {gated && !awaitingApproval && !decision && (
        <div className="tool-gate-note">needs approval (flagged)</div>
      )}
      {awaitingApproval && (
        <div className="tool-approval">
          <span className="tool-gate-note">This tool call is waiting for your approval:</span>
          <div className="tool-approval-actions">
            <button className="btn btn-approve" onClick={() => onDecide?.('approve')}>
              Approve
            </button>
            <button className="btn btn-reject" onClick={() => onDecide?.('reject')}>
              Reject
            </button>
          </div>
        </div>
      )}
      {decision === 'reject' && !result && (
        <div className="tool-gate-note tool-rejected">rejected — not executed</div>
      )}
      <div className="tool-args">
        <div className="tool-label">arguments</div>
        <CollapsiblePre text={renderArgs(args)} maxLines={6} />
      </div>
      {progress && resolved === 'pending' && (
        <details className="tool-progress" open>
          <summary>running… ({progress.trim().split('\n').length} lines)</summary>
          <pre className="tool-progress-log">{progress}</pre>
        </details>
      )}
      {engineInfo && (
        <div className="tool-engine">
          {engineInfo.engine && (
            <span className="tool-engine-badge">引擎 · {engineInfo.engine}</span>
          )}
          {engineInfo.usedTools && engineInfo.usedTools.length > 0 && (
            <span className="tool-engine-tools">
              内部调用：{[...new Set(engineInfo.usedTools)].join(' · ')}
            </span>
          )}
        </div>
      )}
      {result !== undefined && (
        <div className="tool-result">
          <div className="tool-label">result</div>
          {mdPaths.length > 0 && onPreview && (
            <div className="tool-file-links">
              {mdPaths.map((p) => (
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
          <CollapsiblePre text={result} maxLines={12} />
          {shot && (
            <a href={shot} target="_blank" rel="noreferrer">
              <img className="tool-screenshot" src={shot} alt="screenshot" />
            </a>
          )}
        </div>
      )}
    </div>
  )
}
