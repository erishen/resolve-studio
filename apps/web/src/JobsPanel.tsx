import { useEffect, useRef, useState } from 'react'
import { fetchJob } from './api'
import { copyToClipboard, jobToLog } from './export'
import { MessageList } from './MessageList'
import { useJobs } from './hooks/useJobs'
import { JOB_EXAMPLES } from './jobExamples'
import type { JobStatus, TaskInfo } from './types'

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

function formatTime(iso?: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Background job manager — kick off detached long-running runs, watch their
 * live transcript (re-attachable SSE), cancel or resume them, and browse the
 * artifacts written to the job's own workspace. Rendered on the 任务 tab.
 */
export function JobsPanel({
  tasks,
  onPreview,
}: {
  tasks: TaskInfo[]
  onPreview?: (path: string) => void
}) {
  const jobs = useJobs()
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Grow the background-task textarea with content, capped at a max height
  // (then it scrolls instead of overflowing the panel).
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  // Keep height in sync when the value is set externally (e.g. an example pick).
  useEffect(() => {
    autoGrow(taRef.current)
  }, [prompt])

  const taskName = (id?: string) => (id ? (tasks.find((t) => t.id === id)?.name ?? id) : '')

  const submit = async () => {
    const p = prompt.trim()
    if (!p || creating) return
    setCreating(true)
    try {
      await jobs.create({ prompt: p })
      setPrompt('')
    } finally {
      setCreating(false)
    }
  }

  // Fetch the full record (the list only carries summaries) and copy its log.
  const copyLog = async (id: string) => {
    const job = await fetchJob(id)
    if (!job) return
    const ok = await copyToClipboard(jobToLog(job))
    if (ok) {
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600)
    }
  }

  return (
    <div className="jobs">
      <div className="jobs-head">
        <h3 className="task-section-title">后台长时任务</h3>
        <p className="task-section-sub">
          在独立沙箱工作区运行，关掉标签页也不中断；工具白名单、免审批、中间产物随时可见，失败后可续跑。
        </p>
      </div>

      <div className="job-create">
        <textarea
          ref={taRef}
          className="job-create-input"
          placeholder="描述要执行的长任务，例如：用 product-analyze 分析 Notion AI，并把报告保存到工作区"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            autoGrow(e.target)
          }}
          rows={2}
        />
        <div className="job-create-row">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void submit()}
            disabled={creating || !prompt.trim()}
          >
            {creating ? '启动中…' : '🚀 启动后台任务'}
          </button>
        </div>
      </div>

      {!jobs.selected && (
        <div className="job-examples">
          <div className="job-examples-title">试试这些（点击填入）</div>
          <div className="job-examples-grid">
            {JOB_EXAMPLES.map((ex) => (
              <button
                key={ex.id}
                className="example-card job-example-card"
                onClick={() => setPrompt(ex.prompt)}
                title={ex.prompt}
              >
                <span className="example-title">{ex.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {jobs.error && <div className="job-error">{jobs.error}</div>}

      {jobs.selected ? (
        <div className="job-detail">
          <div className="job-detail-head">
            <button className="btn btn-sm" onClick={jobs.close}>
              ← 返回列表
            </button>
            <span className={`job-status job-status-${jobs.selected.status}`}>
              {STATUS_LABEL[jobs.selected.status] ?? jobs.selected.status}
            </span>
            <span className="job-detail-name">{jobs.selected.name}</span>
            <div className="job-detail-actions">
              {(jobs.selected.status === 'running' || jobs.selected.status === 'queued') && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void jobs.cancel(jobs.selected!.id)}
                >
                  取消任务
                </button>
              )}
              {(jobs.selected.status === 'failed' || jobs.selected.status === 'cancelled') && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => void jobs.resume(jobs.selected!.id, '继续完成剩余工作')}
                >
                  ▶ 续跑
                </button>
              )}
              <button
                className="btn btn-sm"
                title="复制完整运行日志（提示词 + 事件 + 用量 + 错误）"
                onClick={() => void copyLog(jobs.selected!.id)}
              >
                {copiedId === jobs.selected.id ? '✓ 已复制' : '复制日志'}
              </button>
            </div>
          </div>
          <div className="job-detail-meta">
            {jobs.selected.taskId && <span>任务：{taskName(jobs.selected.taskId)}</span>}
            {jobs.selected.workspace && (
              <span className="job-workspace" title={jobs.selected.workspace}>
                工作区：…/{jobs.selected.workspace.split('/').slice(-3).join('/')}
              </span>
            )}
            {jobs.selected.startedAt && <span>开始：{formatTime(jobs.selected.startedAt)}</span>}
            {jobs.selected.finishedAt && <span>结束：{formatTime(jobs.selected.finishedAt)}</span>}
            {jobs.selected.usage && (
              <span>
                用量：
                {(jobs.selected.usage.prompt + jobs.selected.usage.completion).toLocaleString()} tok
              </span>
            )}
          </div>
          {jobs.selected.includeTools && jobs.selected.includeTools.length > 0 && (
            <div className="job-whitelist">
              <span className="job-whitelist-label">工具白名单：</span>
              {jobs.selected.includeTools.map((t) => (
                <span key={t} className="task-chip">
                  {t}
                </span>
              ))}
            </div>
          )}
          {jobs.selected.error && <div className="job-detail-error">{jobs.selected.error}</div>}
          <MessageList
            messages={jobs.messages}
            busy={jobs.selected.status === 'running' || jobs.selected.status === 'queued'}
            onPreview={onPreview}
          />
          {jobs.files.length > 0 && (
            <div className="job-files">
              <div className="job-files-title">工作区产物（{jobs.files.length}）</div>
              <div className="job-files-list">
                {jobs.files.map((f) => (
                  <button
                    key={f.path}
                    className="job-file"
                    onClick={() => onPreview?.(`${jobs.selected!.workspace}/${f.path}`)}
                    title="点击预览"
                  >
                    <span className="job-file-path">📄 {f.path}</span>
                    <span className="job-file-meta">
                      {formatSize(f.size)} · {formatTime(f.mtime)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="job-list">
          {jobs.jobs.length === 0 && (
            <div className="job-empty">还没有后台任务，用上面的输入框启动一个。</div>
          )}
          {jobs.jobs.map((j) => (
            <div key={j.id} className="job-row" onClick={() => void jobs.open(j.id)}>
              <span className={`job-status job-status-${j.status}`}>
                {STATUS_LABEL[j.status] ?? j.status}
              </span>
              <span className="job-row-name">{j.name}</span>
              <span className="job-row-meta">{formatTime(j.updatedAt)}</span>
              {(j.status === 'running' || j.status === 'queued') && (
                <button
                  className="btn btn-sm btn-danger"
                  title="取消任务"
                  onClick={(e) => {
                    e.stopPropagation()
                    void jobs.cancel(j.id)
                  }}
                >
                  ⏹
                </button>
              )}
              {(j.status === 'failed' || j.status === 'cancelled') && (
                <button
                  className="btn btn-sm btn-primary"
                  title="续跑"
                  onClick={(e) => {
                    e.stopPropagation()
                    void jobs.resume(j.id, '继续完成剩余工作')
                  }}
                >
                  ▶
                </button>
              )}
              <button
                className="btn btn-sm"
                title="删除任务（含工作区文件）"
                onClick={(e) => {
                  e.stopPropagation()
                  void jobs.remove(j.id)
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
