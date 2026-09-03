import { useState, type ReactNode } from 'react'

interface ToolCallCardProps {
  name: string
  args: string | Record<string, unknown>
  result?: string
  ok?: boolean
  /** True if the tool is flagged as needing human approval. */
  gated?: boolean
  /** True while the backend is waiting for a human decision. */
  awaitingApproval?: boolean
  /** True when approval was skipped because it was already approved this run. */
  approvalSkipped?: boolean
  /** The human's decision, once made. */
  decision?: 'approve' | 'reject'
  /** Execution time in milliseconds. */
  durationMs?: number
  /** Streaming progress log for long-running tools. */
  progress?: string
  onDecide?: (decision: 'approve' | 'reject') => void
  onPreview?: (path: string) => void
  /** Direct re-run affordances (tool may ask the user to retry with different args). */
  onRetryTool?: (name: string, args: Record<string, unknown>) => void
  /** Disable the retry buttons while a run/retry is in flight. */
  retryDisabled?: boolean
}

// Sentinel emitted by pse-review when the free default gateway produces an
// unusable report (empty/truncated) — the UI renders a retry choice. The
// sentinel string itself is owned by the resolve-skills submodule.
// Failure returns begin with `error: PSE_RETRY_CHOICE` on their own line. Anchor
// to a line start (allowing the error: prefix) so the marker in SKILL.md's prose
// ("...返回 `PSE_RETRY_CHOICE`...") does not falsely trigger the retry buttons.
const RETRY_CHOICE_RE = /^error:\s*PSE_RETRY_CHOICE\b|^PSE_RETRY_CHOICE\b/m

function renderArgs(args: string | Record<string, unknown>): string {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** Turn URLs in plain text into clickable links (open in new tab). */
function linkify(text: string): ReactNode[] {
  const urlRegex = /(https?:\/\/[^\s<>"')\]]+)/g
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const url = match[0]
    parts.push(
      <a key={match.index} href={url} target="_blank" rel="noreferrer" className="tool-link">
        {url}
      </a>,
    )
    lastIndex = match.index + url.length
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

/** Collapsible <pre>: shows first MAX_LINES by default, toggle to expand. */
function CollapsiblePre({ text, maxLines = 8 }: { text: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false)
  const lines = text.split('\n')
  const needsCollapse = lines.length > maxLines
  const display = expanded ? text : lines.slice(0, maxLines).join('\n')
  return (
    <div className="collapsible-pre">
      <pre className={expanded ? '' : 'pre-collapsed'}>{linkify(display)}</pre>
      {needsCollapse && (
        <button className="btn btn-sm btn-toggle" onClick={() => setExpanded(!expanded)}>
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

/**
 * Extract previewable .md file paths from a tool result.
 * Matches absolute paths under a known root (/Users|/home|/tmp|/var|/opt|/usr|/etc)
 * and relative paths containing at least one "/" (e.g. sandbox/.../foo.md,
 * ./x.md, ../a/b.md) — the server resolves relatives against its cwd and serves
 * them if within fsRoots. URLs containing "://" are skipped. Keep in sync with
 * MessageList's extractMarkdownPaths.
 */
function extractMarkdownPaths(result?: string): string[] {
  if (!result) return []
  const paths = new Set<string>()
  const re = /((?:\/(?:Users|home|tmp|var|opt|usr|etc)|[A-Za-z0-9_.-]+)\/[^\s'"<>]*\.md)/g
  let m
  while ((m = re.exec(result)) !== null) {
    const p = m[1]
    if (p.includes('://')) continue
    paths.add(p)
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
  approvalSkipped,
  decision,
  durationMs,
  progress,
  onDecide,
  onPreview,
  onRetryTool,
  retryDisabled,
}: ToolCallCardProps) {
  const resolved = ok === undefined ? 'pending' : ok ? 'ok' : 'error'
  const shot = screenshotUrl(result)
  const engineInfo = parseEngineInfo(result)
  const mdPaths = extractMarkdownPaths(result)
  const retryChoice = !!result && RETRY_CHOICE_RE.test(result)
  const displayResult =
    result?.replace(/^error:\s*/m, '').replace(/^PSE_RETRY_CHOICE\n?/m, '') ?? result
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
      {approvalSkipped && (
        <div className="tool-gate-note tool-gate-skipped">
          approval skipped (already approved this run)
        </div>
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
          <CollapsiblePre text={displayResult ?? ''} maxLines={12} />
          {retryChoice && onRetryTool && (
            <div className="tool-retry">
              <span className="tool-label">重试选项</span>
              <div className="tool-retry-buttons">
                <button
                  className="btn btn-sm"
                  disabled={retryDisabled}
                  onClick={() => onRetryTool(name, {})}
                  title="用免费默认网关重新跑一次（不指定 provider）"
                >
                  重试（免费）
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={retryDisabled}
                  onClick={() => onRetryTool(name, { provider: 'deepseek' })}
                  title="改用付费 DeepSeek（将触发审批）"
                >
                  改用 DeepSeek（付费·需审批）
                </button>
              </div>
            </div>
          )}
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
