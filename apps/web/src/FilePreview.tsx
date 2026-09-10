import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchFile } from './api'
import { artifactPath, isIframePreview, previewLabel } from './preview'

interface FilePreviewProps {
  path: string
  onClose: () => void
}

interface FrontMatter {
  title?: string
  date?: string
  tags?: string[]
  categories?: string[]
  description?: string
  [key: string]: unknown
}

/**
 * Split a markdown file into YAML front matter and body.
 * Returns { meta, body } — meta is empty object if no front matter.
 */
function parseFrontMatter(content: string): { meta: FrontMatter; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }
  const meta: FrontMatter = {}
  const lines = match[1].split('\n')
  let currentKey: string | null = null
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) {
      currentKey = kv[1]
      let val = kv[2].trim()
      // Strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      // Parse JSON arrays like ["a", "b"]
      if (val.startsWith('[') && val.endsWith(']')) {
        try {
          meta[currentKey] = JSON.parse(val)
        } catch {
          meta[currentKey] = val
        }
      } else {
        meta[currentKey] = val
      }
    } else if (currentKey && line.trim().startsWith('- ')) {
      // YAML list item
      const existing = meta[currentKey]
      const item = line
        .trim()
        .slice(2)
        .replace(/^["']|["']$/g, '')
      if (Array.isArray(existing)) existing.push(item)
      else meta[currentKey] = [item]
    }
  }
  return { meta, body: match[2] }
}

export function FilePreview({ path, onClose }: FilePreviewProps) {
  const [rawContent, setRawContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered')
  // Maximise the modal to fill the viewport (a CSS toggle — no Fullscreen API,
  // so it works the same for local srcDoc and remote iframe content, and Esc
  // exits the maximised state before closing the preview).
  const [fullscreen, setFullscreen] = useState(false)

  // http(s) preview URLs (e.g. the csv-analyze local report server) are rendered
  // in an iframe as-is; local files go through the /api/file text proxy below.
  const isHttpUrl = /^https?:\/\//i.test(path)
  const isMarkdown = /\.md$/i.test(path) && !isHttpUrl
  // A local .html artifact (e.g. csv-analyze's report saved into the job
  // workspace) is fetched as text then rendered in an iframe via srcDoc, so it
  // shows as a rendered page instead of raw HTML source.
  // Artifact links (`/api/raw?path=<abs>.html`) keep the .html inside the query
  // string, so inspect the *decoded* path — not the URL pathname (`/api/raw`) —
  // or the modal silently falls through to an empty <pre> instead of the iframe.
  const isHtmlUrl = isIframePreview(path)
  const isLocalHtml = !isHttpUrl && /\.html?$/i.test(path)

  const { meta, body } = useMemo(
    () =>
      isMarkdown ? parseFrontMatter(rawContent) : { meta: {} as FrontMatter, body: rawContent },
    [rawContent, isMarkdown],
  )

  const hasFrontMatter = Object.keys(meta).length > 0

  useEffect(() => {
    if (isHttpUrl) {
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchFile(path)
      .then((data) => {
        if (!cancelled) {
          setRawContent(data.content)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError((err as Error).message)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [path, isHttpUrl])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc backs out of fullscreen first; a second Esc closes the modal.
        if (fullscreen) setFullscreen(false)
        else onClose()
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        const t = e.target as HTMLElement | null
        // Don't hijack the key while the user is typing somewhere behind us.
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
        e.preventDefault()
        setFullscreen((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, fullscreen])

  const filename = previewLabel(path)
  const displayTitle = (meta.title as string) || filename

  return (
    <div className={`file-preview-overlay${fullscreen ? ' fullscreen' : ''}`} onClick={onClose}>
      <div
        className={`file-preview-modal${fullscreen ? ' fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="file-preview-header">
          <span className="file-preview-title">{displayTitle}</span>
          <span className="file-preview-path">{artifactPath(path) ?? path}</span>
          {isMarkdown && !isHtmlUrl && (
            <div className="file-preview-toggle">
              <button
                className={`btn btn-sm${viewMode === 'rendered' ? ' btn-active' : ''}`}
                onClick={() => setViewMode('rendered')}
              >
                渲染
              </button>
              <button
                className={`btn btn-sm${viewMode === 'source' ? ' btn-active' : ''}`}
                onClick={() => setViewMode('source')}
              >
                源码
              </button>
            </div>
          )}
          {isLocalHtml && (
            <div className="file-preview-toggle">
              <button
                className={`btn btn-sm${viewMode === 'rendered' ? ' btn-active' : ''}`}
                onClick={() => setViewMode('rendered')}
              >
                渲染
              </button>
              <button
                className={`btn btn-sm${viewMode === 'source' ? ' btn-active' : ''}`}
                onClick={() => setViewMode('source')}
              >
                源码
              </button>
            </div>
          )}
          <button
            className="file-preview-fs"
            onClick={() => setFullscreen((v) => !v)}
            title={fullscreen ? '退出全屏 (Esc / F)' : '全屏 (F)'}
            aria-label={fullscreen ? '退出全屏' : '全屏'}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {fullscreen ? (
                // collapse: corners pointing inward
                <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
              ) : (
                // expand: corners pointing outward
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              )}
            </svg>
          </button>
          <button className="file-preview-close" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>
        <div className="file-preview-body">
          {loading && <div className="file-preview-loading">加载中…</div>}
          {error && <div className="file-preview-error">错误：{error}</div>}
          {!loading && !error && isMarkdown && viewMode === 'rendered' && (
            <>
              {hasFrontMatter && (
                <div className="file-preview-meta">
                  {meta.date && <span className="meta-item">📅 {meta.date}</span>}
                  {Array.isArray(meta.tags) && meta.tags.length > 0 && (
                    <span className="meta-item">🏷 {meta.tags.join(' · ')}</span>
                  )}
                  {Array.isArray(meta.categories) && meta.categories.length > 0 && (
                    <span className="meta-item">📂 {meta.categories.join(' · ')}</span>
                  )}
                </div>
              )}
              <div className="file-preview-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
              </div>
            </>
          )}
          {!loading && !error && isHtmlUrl && (
            <iframe
              className="file-preview-iframe"
              src={path}
              title="HTML 报告预览"
              sandbox="allow-scripts allow-same-origin"
            />
          )}
          {!loading && !error && isLocalHtml && viewMode === 'rendered' && (
            <iframe
              className="file-preview-iframe"
              srcDoc={rawContent}
              title="HTML 报告预览"
              sandbox="allow-scripts allow-same-origin"
            />
          )}
          {!loading &&
            !error &&
            ((viewMode === 'source' && (isMarkdown || isLocalHtml)) ||
              (!isMarkdown && !isLocalHtml && !isHtmlUrl)) && (
              <pre className="file-preview-content">{rawContent}</pre>
            )}
        </div>
      </div>
    </div>
  )
}
