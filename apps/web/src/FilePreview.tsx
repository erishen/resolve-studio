import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fetchFile } from './api'

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

  // http(s) preview URLs (e.g. the csv-analyze local report server) are rendered
  // in an iframe as-is; local files go through the /api/file text proxy below.
  const isHttpUrl = /^https?:\/\//i.test(path)
  const isMarkdown = /\.md$/i.test(path) && !isHttpUrl
  // A local .html artifact (e.g. csv-analyze's report saved into the job
  // workspace) is fetched as text then rendered in an iframe via srcDoc, so it
  // shows as a rendered page instead of raw HTML source.
  const isHtmlUrl = isHttpUrl && /\.html?$/i.test(new URL(path, window.location.href).pathname)
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
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const filename = path.split('/').pop() ?? path
  const displayTitle = (meta.title as string) || filename

  return (
    <div className="file-preview-overlay" onClick={onClose}>
      <div className="file-preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="file-preview-header">
          <span className="file-preview-title">{displayTitle}</span>
          <span className="file-preview-path">{path}</span>
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
