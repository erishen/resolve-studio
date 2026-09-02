import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchWorkspace,
  fetchWorkspaceStatus,
  rescanWorkspace,
  stopWorkspace,
  type WorkspaceData,
  type WorkspaceProject,
  type WorkspaceStatus,
} from './api'

const POLL_MS = 3000

export interface WorkspaceViewProps {
  /** Callback when user clicks a quick-action button on a project card. */
  onRunTask?: (projectKey: string, taskType: string, prompt: string) => void
}

interface QuickTask {
  label: string
  icon: string
  taskType: string
  prompt: (projectKey: string) => string
}

/**
 * Map project keys to their native quick-action tasks.
 * PSE framework projects expose their own capability; other projects default
 * to "write an article about this project".
 */
function getQuickTasks(projectKey: string): QuickTask[] {
  const k = projectKey.toLowerCase()

  // PSE framework projects: expose their native capability
  if (k === 'crewai-pse') {
    return [
      {
        label: '写文章',
        icon: '✍️',
        taskType: 'article',
        prompt: (pk) => `帮我写一篇技术文章，用 ${pk} 三角色流水线生成。`,
      },
    ]
  }
  if (k === 'autogen-pse' || k === 'autogen-pse-architecture') {
    return [
      {
        label: '资产分析',
        icon: '📊',
        taskType: 'portfolio',
        prompt: () => '帮我做一份投资组合分析，用 portfolio-summary 工具生成。',
      },
    ]
  }
  if (k === 'llamaindex-pse') {
    return [
      {
        label: '热点选题生成',
        icon: '🔥',
        taskType: 'hot-news',
        prompt: () =>
          '帮我走一遍热点内容流水线：先抓取最新热点新闻素材，列出候选话题，挑一个 AI 相关的热点生成小红书文案并校验合规。',
      },
      {
        label: '简历定制',
        icon: '📄',
        taskType: 'resume',
        prompt: () => '帮我定制一份简历，用 resume-tailor 工具生成。',
      },
    ]
  }
  if (k === 'langgraph-pse') {
    return [
      {
        label: '面试题',
        icon: '🎯',
        taskType: 'interview',
        prompt: () => '帮我生成一份技术面试题库，用 interview-questions 工具生成。',
      },
      {
        label: 'CRM 复盘',
        icon: '🔄',
        taskType: 'crm',
        prompt: () => '帮我生成一份本周的 CRM 关系复盘，用 crm-task 工具生成。',
      },
    ]
  }

  // Stock / finance projects
  if (/stock|invest|portfolio|asset|finance/i.test(k)) {
    return [
      {
        label: '资产分析',
        icon: '📊',
        taskType: 'portfolio',
        prompt: () => '帮我做一份投资组合分析，用 portfolio-summary 工具生成。',
      },
    ]
  }

  // CRM / contact projects
  if (/crm|contact|follow|relation/i.test(k)) {
    return [
      {
        label: 'CRM 复盘',
        icon: '🔄',
        taskType: 'crm',
        prompt: () => '帮我生成一份本周的 CRM 关系复盘，用 crm-task 工具生成。',
      },
    ]
  }

  // Interview / question projects
  if (/interview|question|quiz/i.test(k)) {
    return [
      {
        label: '面试题',
        icon: '🎯',
        taskType: 'interview',
        prompt: (pk) => `帮我生成一份针对 ${pk} 的面试题库，用 interview-questions 工具生成。`,
      },
    ]
  }

  // Default: any project gets a richer set of quick actions
  return [
    {
      label: '写文章',
      icon: '✍️',
      taskType: 'article',
      prompt: (pk) => `帮我写一篇 ${pk} 的技术文章，用 crewai-pse 三角色流水线生成。`,
    },
    {
      label: '架构分析',
      icon: '🏗️',
      taskType: 'architecture',
      prompt: (pk) =>
        `分析 ${pk} 项目的整体架构、技术栈和核心模块，输出架构说明，包括目录结构、关键组件、数据流和依赖关系。`,
    },
    {
      label: '生成文档',
      icon: '📝',
      taskType: 'readme',
      prompt: (pk) =>
        `基于 ${pk} 的代码，生成一份完整的 README 文档，包含项目介绍、功能特性、技术栈、安装步骤、使用方法和架构说明。`,
    },
  ]
}

/**
 * Workspace view: surfaces the workspace code-analysis report inside
 * the app. Lists every tracked project as a card (languages, symbol/diagnostic
 * counts, status, links) and lets the user trigger a background re-scan whose
 * progress is polled from `/api/workspace/status`.
 */
export function WorkspaceView({ onRunTask }: WorkspaceViewProps = {}) {
  const [data, setData] = useState<WorkspaceData>({ generatedAt: null, projects: [] })
  const [status, setStatus] = useState<WorkspaceStatus>({ status: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<number | null>(null)

  const load = async () => {
    try {
      const [d, s] = await Promise.all([fetchWorkspace(), fetchWorkspaceStatus()])
      setData(d)
      setStatus(s)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    void load()
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current)
    }
  }, [])

  // Poll while a scan runs; refresh BOTH status and the project list on every
  // tick so each finished project appears in the UI immediately (the generator
  // persists projects.json incrementally as it completes each one). When the
  // scan stops (done/terminated/idle/error) we stop polling and do a final
  // refresh so partial results from an interrupted run are shown.
  useEffect(() => {
    if (status.status === 'running') {
      if (pollRef.current == null) {
        pollRef.current = window.setInterval(async () => {
          const [s, d] = await Promise.all([fetchWorkspaceStatus(), fetchWorkspace()])
          setStatus(s)
          setData(d)
        }, POLL_MS)
      }
    } else {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      void fetchWorkspace().then(setData)
    }
  }, [status.status])

  const rescan = async (force = false) => {
    setBusy(true)
    setError(null)
    const r = await rescanWorkspace(force)
    setBusy(false)
    if ('error' in r) {
      setError(r.error)
      return
    }
    // Optimistically flip to "running" so the UI reacts before the first poll.
    setStatus({
      status: 'running',
      startedAt: new Date().toISOString(),
      total: data.projects.length || undefined,
      current: 0,
      currentKey: '',
      skipped: 0,
    })
  }

  const stopScan = async () => {
    setBusy(true)
    setError(null)
    const r = await stopWorkspace()
    setBusy(false)
    if ('error' in r) {
      setError(r.error)
      return
    }
    // Optimistically flip to "terminated" so polling stops at once; the final
    // poll already refreshed the partial results.
    setStatus((s) => ({ ...s, status: 'terminated' }))
  }

  const scanning = status.status === 'running'
  const pct =
    scanning && status.total ? Math.round(((status.current ?? 0) / status.total) * 100) : 0

  // Sort: mixed repos first, then more quick-action buttons, then by name.
  const sortedProjects = useMemo(() => {
    const projects = [...(data.projects ?? [])]
    projects.sort((a, b) => {
      // 1. mixed repos first
      const mixedDiff = (b.mixed ? 1 : 0) - (a.mixed ? 1 : 0)
      if (mixedDiff !== 0) return mixedDiff
      // 2. more quick-action buttons first
      const aTasks = getQuickTasks(a.key).length
      const bTasks = getQuickTasks(b.key).length
      const taskDiff = bTasks - aTasks
      if (taskDiff !== 0) return taskDiff
      // 3. by name
      return a.key.localeCompare(b.key)
    })
    return projects
  }, [data.projects])

  return (
    <div className="ws">
      <div className="ws-head">
        <div>
          <h2 className="ws-title">工作区项目分析</h2>
          <p className="ws-sub">
            工作区下「有 GitHub 链接 + 已写文章」的项目 ·
            {data.generatedAt
              ? ` 报告生成于 ${new Date(data.generatedAt).toLocaleString()}`
              : ' 尚未生成报告'}
          </p>
        </div>
        <div className="ws-actions">
          {scanning ? (
            <button className="btn btn-stop" onClick={() => void stopScan()} disabled={busy}>
              停止扫描
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary"
                onClick={() => void rescan()}
                disabled={busy}
                title="跳过源码未变更的项目（复用缓存），仅分析有改动的项目"
              >
                重新检测
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void rescan(true)}
                disabled={busy}
                title="忽略缓存，对全部项目重新跑 LSP 分析（耗时较长）"
              >
                强制全量重扫
              </button>
            </>
          )}
        </div>
      </div>

      {scanning && (
        <div className="ws-progress">
          <div className="ws-progress-bar" style={{ width: `${pct}%` }} />
          <div className="ws-progress-text">
            正在分析 {status.current ?? 0} / {status.total ?? 0}
            {status.currentKey ? ` · ${status.currentKey}` : ''}
            {status.skipped ? ` · 已跳过缓存 ${status.skipped}` : ''}
          </div>
        </div>
      )}
      {status.status === 'terminated' && (
        <div className="ws-terminated">
          扫描已停止 · 已保留完成的项目结果（可点「重新检测」续跑未变更跳过的部分）
        </div>
      )}

      {error && <div className="error-bar">{error}</div>}

      {(data.projects ?? []).length === 0 && !scanning && (
        <div className="ws-empty">
          暂无分析结果。点击「重新检测」开始扫描（首次全量约需 20 分钟，可在进度中查看）。
        </div>
      )}

      <div className="ws-grid">
        {sortedProjects.map((p) => (
          <ProjectCard key={p.key} p={p} onRunTask={onRunTask} />
        ))}
      </div>
    </div>
  )
}

function badgeClass(p: WorkspaceProject): string {
  if (p.cached) return 'ws-badge ws-badge-cached'
  switch (p.lspStatus) {
    case 'ok':
      return 'ws-badge ws-badge-ok'
    case 'lsp-missing':
    case 'error':
      return 'ws-badge ws-badge-warn'
    default:
      return 'ws-badge ws-badge-muted'
  }
}

function badgeText(p: WorkspaceProject): string {
  if (p.cached) return '已缓存·跳过'
  if (p.status === 'missing') return '目录缺失'
  if (p.lspStatus === 'ok') return '已深度分析'
  if (p.lspStatus === 'lsp-missing') return 'LSP 未装·仅结构'
  if (p.lspStatus === 'error') return '部分失败'
  if (p.lspStatus === 'no-lsp-needed') return '无构建文件'
  return p.status || '未知'
}

function ProjectCard({
  p,
  onRunTask,
}: {
  p: WorkspaceProject
  onRunTask?: (projectKey: string, taskType: string, prompt: string) => void
}) {
  const links: JSX.Element[] = [
    <a key="gh" className="ws-link" href={p.github} target="_blank" rel="noopener noreferrer">
      GitHub ↗
    </a>,
  ]
  if (p.article?.zh) {
    links.push(
      <a
        key="zh"
        className="ws-link"
        href={p.article.zh.link}
        target="_blank"
        rel="noopener noreferrer"
      >
        文章·中 ↗
      </a>,
    )
  }
  if (p.article?.en) {
    links.push(
      <a
        key="en"
        className="ws-link"
        href={p.article.en.link}
        target="_blank"
        rel="noopener noreferrer"
      >
        文章·英 ↗
      </a>,
    )
  }

  const quickTasks = onRunTask ? getQuickTasks(p.key) : []

  return (
    <div className="ws-card">
      <div className="ws-card-head">
        <span className="ws-card-name">{p.key}</span>
        <span className="ws-lang">{(p.languages ?? []).join('/') || '?'}</span>
      </div>
      <div className="ws-card-stats">
        <span className={badgeClass(p)}>{badgeText(p)}</span>
        {p.lspStatus === 'ok' && (
          <span className="ws-metric">
            {p.symbolCount ?? 0} 符号 · {p.diagCount ?? 0} 诊断
          </span>
        )}
        {p.mixed && <span className="ws-metric ws-metric-mixed">混仓</span>}
      </div>
      {p.note && !p.note.includes('混仓') && <div className="ws-note">{p.note}</div>}
      <div className="ws-card-links">
        {links}
        <a
          className="ws-link ws-link-report"
          href={`/api/workspace/report#${p.key}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          完整报告 ↗
        </a>
      </div>
      {quickTasks.length > 0 && (
        <div className="ws-card-actions">
          {quickTasks.map((t) => (
            <button
              key={t.taskType}
              className="btn btn-sm ws-action-btn"
              onClick={() => onRunTask?.(p.key, t.taskType, t.prompt(p.key))}
              title={t.prompt(p.key)}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
