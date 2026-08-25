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
  onDecide?: (decision: 'approve' | 'reject') => void
}

function renderArgs(args: string | Record<string, unknown>): string {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
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
  onDecide,
}: ToolCallCardProps) {
  const resolved = ok === undefined ? 'pending' : ok ? 'ok' : 'error'
  const shot = screenshotUrl(result)
  const engineInfo = parseEngineInfo(result)
  return (
    <div className={`tool-card tool-${resolved}${gated ? ' tool-card-gated' : ''}`}>
      <div className="tool-head">
        <span className="tool-name">{name}{gated ? ' ⚠' : ''}</span>
        <span className={`tool-badge tool-badge-${resolved}`}>
          {awaitingApproval ? 'awaiting approval' : decision ?? resolved}
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
        <pre>{renderArgs(args)}</pre>
      </div>
      {engineInfo && (
        <div className="tool-engine">
          {engineInfo.engine && <span className="tool-engine-badge">引擎 · {engineInfo.engine}</span>}
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
          <pre>{result}</pre>
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
