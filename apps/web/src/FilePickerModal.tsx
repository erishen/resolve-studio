import { useCallback, useEffect, useState } from 'react'
import { fetchFs, type FsEntry } from './api'

interface FilePickerModalProps {
  open: boolean
  onClose: () => void
  /** Called with the absolute server-side path of the chosen file. */
  onSelect: (path: string) => void
  /** Called with the absolute server-side path of a chosen directory. */
  onSelectDir?: (path: string) => void
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function FilePickerModal({ open, onClose, onSelect, onSelectDir }: FilePickerModalProps) {
  const [dir, setDir] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [atRoot, setAtRoot] = useState(false)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    try {
      const listing = await fetchFs(target || undefined)
      setDir(listing.dir)
      setParent(listing.parent)
      setAtRoot(Boolean(listing.atRoot))
      setEntries(listing.entries)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Reset to the root view whenever the modal is (re)opened.
  useEffect(() => {
    if (open) void load('')
  }, [open, load])

  if (!open) return null

  const isRootView = dir === ''
  // At a read root we can't go above it, but we can return to the root list.
  const canGoUp = !isRootView && (atRoot || Boolean(parent))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal file-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">选择文件 / 目录</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="file-picker-bar">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!canGoUp || loading}
            onClick={() => (atRoot ? void load('') : parent && void load(parent))}
            title={atRoot ? '返回根目录列表' : '返回上一级目录'}
          >
            ↑ 上一级
          </button>
          <span className="file-picker-path">
            {isRootView ? '可读根目录（沙箱允许范围）' : dir}
          </span>
        </div>

        {error && <div className="error-bar">{error}</div>}

        <div className="file-list">
          {loading && <div className="file-empty">加载中…</div>}
          {!loading && entries.length === 0 && <div className="file-empty">空目录</div>}
          {!loading &&
            entries.map((e) => (
              <div
                key={e.path}
                className={`file-row${e.isDir ? ' file-row-dir' : ''}`}
                onClick={() => (e.isDir ? void load(e.path) : onSelect(e.path))}
                title={e.path}
              >
                <span className="file-icon">{e.isDir ? '📁' : '📄'}</span>
                <span className="file-name">{e.name}</span>
                {!e.isDir && <span className="file-size">{formatSize(e.size)}</span>}
                {e.isDir && onSelectDir && (
                  <button
                    type="button"
                    className="btn btn-sm file-row-select"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      onSelectDir(e.path)
                    }}
                    title="选择此目录"
                  >
                    选择
                  </button>
                )}
              </div>
            ))}
        </div>

        <div className="file-picker-foot">
          点击文件夹进入；点文件填入路径；目录行右侧「选择」将其路径填入
        </div>
      </div>
    </div>
  )
}
