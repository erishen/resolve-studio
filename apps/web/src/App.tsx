import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchModels, fetchPseStatus, fetchSkills, fetchTools, setPseEnabled, type SkillInfo } from './api'
import { Composer, type ComposerHandle } from './Composer'
import { FilePickerModal } from './FilePickerModal'
import { FilePreview } from './FilePreview'
import { MessageList } from './MessageList'
import { WorkspaceView } from './WorkspaceView'
import { buildExamples, flattenExamples, FALLBACK_EXAMPLES } from './examples'
import { useChat } from './hooks/useChat'
import { useMcp } from './hooks/useMcp'
import { useSessions } from './hooks/useSessions'
import { useMemory } from './hooks/useMemory'
import { copyToClipboard, downloadText, messagesToMarkdown, safeFilename } from './export'
import { PROMPT_TEMPLATES } from './prompts'
import type { ModelInfo, ToolSchema, UIMessage } from './types'

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function formatUsage(usage: { prompt: number; completion: number; cost: number }): string {
  const tokens = usage.prompt + usage.completion
  const tokStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
  const costStr = usage.cost > 0 ? ` · ¥${usage.cost.toFixed(4)}` : ''
  return `${tokStr} tok${costStr}`
}

export function App() {
  // ---- runtime metadata (models / tools / skills) ----
  const [models, setModels] = useState<ModelInfo[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [pseEnabled, setPseEnabledState] = useState(false)
  const [model, setModel] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // ---- UI state ----
  const [draft, setDraft] = useState('')
  const [showFilePicker, setShowFilePicker] = useState(false)
  const [view, setView] = useState<'chat' | 'workspace'>('chat')
  const [openSkill, setOpenSkill] = useState<string | null>(null)
  const [openMcp, setOpenMcp] = useState<string | null>(null)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [exportToast, setExportToast] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [promptTemplateId, setPromptTemplateId] = useState<string>('default')
  const [isDragging, setIsDragging] = useState(false)
  const [sessionSearch, setSessionSearch] = useState('')
  const [memoryInput, setMemoryInput] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light'
    const saved = localStorage.getItem('harness-theme') as 'light' | 'dark' | null
    if (saved) return saved
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const composerRef = useRef<ComposerHandle>(null)

  // Apply theme to <html> and persist.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('harness-theme', theme)
  }, [theme])

  // ---- domain hooks ----
  const sessions = useSessions()
  const mcp = useMcp()
  const memory = useMemory()
  const combinedSystemPrompt = [
    PROMPT_TEMPLATES.find((t) => t.id === promptTemplateId)?.systemPrompt,
    memory.systemPrompt,
  ]
    .filter(Boolean)
    .join('\n\n')
  const chat = useChat({
    tools,
    model,
    sessionId: sessions.sessionId,
    systemPrompt: combinedSystemPrompt || undefined,
    onRunComplete: useCallback(
      (msgs: UIMessage[]) => {
        // Persist a brand-new conversation (no session id yet).
        sessions.ensureSession(msgs, sessions.sessionId)
      },
      [sessions],
    ),
  })

  // Load models/tools/skills on mount. Session list + MCP servers are loaded
  // by their respective hooks.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [m, t, sk, pse] = await Promise.all([fetchModels(), fetchTools(), fetchSkills(), fetchPseStatus()])
        if (cancelled) return
        setModels(m.models)
        setTools(t)
        setSkills(sk)
        setPseEnabledState(pse.enabled)
        const preferred =
          m.defaultModel && m.models.some((x) => x.id === m.defaultModel)
            ? m.defaultModel
            : (m.models[0]?.id ?? '')
        setModel(preferred)
      } catch (err) {
        if (!cancelled) setError(`failed to load runtime info: ${(err as Error).message}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced auto-save whenever the conversation changes.
  useEffect(() => {
    if (!sessions.sessionId || !chat.messages.length) return
    const t = setTimeout(() => {
      void sessions.save(sessions.sessionId!, chat.messages).catch(() => {
        /* offline / backend down: skip silently */
      })
    }, 800)
    return () => clearTimeout(t)
  }, [chat.messages, sessions.sessionId, sessions.save])

  // ---- example prompts (grouped by category) ----
  const examples = useMemo(() => {
    const built = buildExamples(tools, skills)
    const flat = flattenExamples(built)
    return flat.length ? built : { article: FALLBACK_EXAMPLES, invest: [], interview: [], crm: [], pse: [], code: [], other: [] }
  }, [tools, skills])

  // ---- session search ----
  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase()
    if (!q) return sessions.sessions
    return sessions.sessions.filter((s) => s.title.toLowerCase().includes(q))
  }, [sessions.sessions, sessionSearch])

  // ---- file picker helpers ----
  const insertPath = (p: string) => {
    setDraft((d) => (d.trim() ? `${d.trim()} ${p}` : `读取 ${p} 的内容，并总结它做了什么。`))
    setShowFilePicker(false)
    composerRef.current?.focus()
  }
  const insertDir = (p: string) => {
    setDraft((d) => (d.trim() ? `${d.trim()} ${p}` : `分析 ${p} 目录，并总结它做了什么。`))
    setShowFilePicker(false)
    composerRef.current?.focus()
  }

  // ---- workspace quick-action: jump to chat with prefilled prompt ----
  const handleRunTask = (_projectKey: string, _taskType: string, prompt: string) => {
    setDraft(prompt)
    setView('chat')
    setTimeout(() => composerRef.current?.focus(), 100)
  }

  // ---- session actions ----
  const newChat = () => {
    chat.reset()
    sessions.setSessionId(null)
    setError(null)
  }

  // Global keyboard shortcuts (registered after chat/newChat exist).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (e.key === 'Escape' && chat.busy) {
        e.preventDefault()
        chat.stop()
        return
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newChat()
        return
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        composerRef.current?.focus()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.busy, chat.stop, newChat])

  const selectSession = async (id: string) => {
    if (chat.busy) return
    const msgs = await sessions.select(id)
    if (!msgs) {
      setError('session not found')
      return
    }
    chat.setMessages(
      msgs.map((m) => ({
        id: uid(),
        role: m.role as 'user' | 'assistant',
        content: m.content,
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.toolCalls && m.toolCalls.length
          ? { toolCalls: m.toolCalls.map((tc) => ({ ...tc, awaitingApproval: false })) }
          : {}),
      })),
    )
    setError(null)
  }

  const removeSession = async (id: string) => {
    await sessions.remove(id)
    if (sessions.sessionId === id) chat.reset()
  }

  const clearAll = async () => {
    if (chat.busy) return
    if (!window.confirm('清空所有会话？此操作不可撤销。')) return
    await sessions.clearAll()
    chat.reset()
    setError(null)
  }

  // ---- approval ----
  const onDecide = async (callId: string, decision: 'approve' | 'reject') => {
    await chat.handleDecision(callId, decision)
  }

  // ---- export ----
  const currentTitle =
    sessions.sessions.find((s) => s.id === sessions.sessionId)?.title ?? 'Conversation'
  const flashToast = (msg: string) => {
    setExportToast(msg)
    setTimeout(() => setExportToast(null), 2000)
  }
  const exportMarkdown = () => {
    const md = messagesToMarkdown(chat.messages, currentTitle)
    downloadText(safeFilename(currentTitle, 'md'), md, 'text/markdown')
    setShowMoreMenu(false)
    flashToast('Exported Markdown')
  }
  const exportJson = () => {
    downloadText(
      safeFilename(currentTitle, 'json'),
      JSON.stringify(chat.messages, null, 2),
      'application/json',
    )
    setShowMoreMenu(false)
    flashToast('Exported JSON')
  }
  const copyMarkdown = async () => {
    const md = messagesToMarkdown(chat.messages, currentTitle)
    const ok = await copyToClipboard(md)
    setShowMoreMenu(false)
    flashToast(ok ? 'Copied to clipboard' : 'Copy failed')
  }

  // ---- file drag & drop ----
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    if (e.currentTarget === e.target) setIsDragging(false)
  }
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    // Read each text file and append its path to the composer.
    const parts: string[] = []
    for (const file of files) {
      if (file.size > 1024 * 1024) {
        flashToast(`Skipped ${file.name}: >1MB`)
        continue
      }
      try {
        const text = await file.text()
        parts.push(`File: ${file.name}\n\`\`\`\n${text}\n\`\`\``)
      } catch {
        flashToast(`Failed to read ${file.name}`)
      }
    }
    if (parts.length) {
      setDraft((d) => (d.trim() ? `${d}\n\n${parts.join('\n\n')}` : parts.join('\n\n')))
      composerRef.current?.focus()
      flashToast(`Attached ${parts.length} file${parts.length > 1 ? 's' : ''}`)
    }
  }

  return (
    <div className="app">
      {loading ? (
        <div className="app-loading">
          <div className="app-loading-spinner" />
          <div>Loading runtime…</div>
        </div>
      ) : (
        <>
          <aside className="sidebar">
            <div className="sidebar-head">
              <button className="btn btn-primary" onClick={newChat} disabled={chat.busy}>
                + New chat
              </button>
              <button
                className="btn btn-danger"
                onClick={() => void clearAll()}
                disabled={chat.busy || sessions.sessions.length === 0}
                title="清空所有会话（不可撤销）"
              >
                清空全部会话
              </button>
            </div>
            <div className="session-search-wrap">
              <input
                className="session-search"
                type="text"
                placeholder="Search sessions…"
                value={sessionSearch}
                onChange={(e) => setSessionSearch(e.target.value)}
              />
            </div>
            <div className="session-list">
              {filteredSessions.length === 0 && (
                <div className="session-empty">
                  {sessions.sessions.length === 0 ? 'no saved sessions' : 'no matches'}
                </div>
              )}
              {filteredSessions.map((s) => (
                <div
                  key={s.id}
                  className={`session-item${s.id === sessions.sessionId ? ' session-active' : ''}`}
                  onClick={() => void selectSession(s.id)}
                >
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">
                    {s.messageCount} msgs · {new Date(s.updatedAt).toLocaleString()}
                  </div>
                  <button
                    className="session-delete"
                    title="delete session"
                    onClick={(e) => {
                      e.stopPropagation()
                      void removeSession(s.id)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </aside>

          <main
            className="main"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <header className="app-header">
              <div className="app-header-left">
                <div className="app-title" title="Resolve Studio">
                  <span className="dot" />
                  <span className="app-title-text">Resolve Studio</span>
                </div>
                <div className="app-nav">
                  <button
                    className={`app-nav-btn${view === 'chat' ? ' active' : ''}`}
                    onClick={() => setView('chat')}
                  >
                    对话
                  </button>
                  <button
                    className={`app-nav-btn${view === 'workspace' ? ' active' : ''}`}
                    onClick={() => setView('workspace')}
                  >
                    工作区
                  </button>
                </div>
              </div>
              <div className="app-header-center">
                <span className="usage-badge" title="本会话累计 token 与估算费用（¥）">
                  {formatUsage(chat.usage)}
                </span>
              </div>
              <div className="app-controls">
                <div className="more-menu-wrap">
                  <button
                    className="btn btn-sm btn-icon"
                    onClick={() => setShowMoreMenu((v) => !v)}
                    title="更多选项"
                  >
                    ⋯
                  </button>
                  {showMoreMenu && (
                    <div className="more-menu" onMouseLeave={() => setShowMoreMenu(false)}>
                      <div className="more-menu-section">
                        <div className="more-menu-title">导出对话</div>
                        <button onClick={exportMarkdown} disabled={chat.messages.length === 0}>📄 Markdown</button>
                        <button onClick={exportJson} disabled={chat.messages.length === 0}>📋 JSON</button>
                        <button onClick={() => void copyMarkdown()} disabled={chat.messages.length === 0}>📋 Copy as Markdown</button>
                      </div>
                      <div className="more-menu-divider" />
                      <button onClick={() => { setTheme((t) => (t === 'dark' ? 'light' : 'dark')); setShowMoreMenu(false); }}>
                        {theme === 'dark' ? '☀️ 浅色模式' : '🌙 深色模式'}
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className={`btn btn-sm${pseEnabled ? ' btn-active' : ''}`}
                  onClick={async () => {
                    const next = !pseEnabled
                    try {
                      const result = await setPseEnabled(next)
                      setPseEnabledState(result)
                    } catch {
                      // ignore network errors
                    }
                  }}
                  disabled={chat.busy}
                  title={pseEnabled ? 'PSE 三角色模式已开启（点击关闭）' : '开启 PSE 三角色模式'}
                >
                  {pseEnabled ? '🧩 PSE 开' : '🧩 PSE 关'}
                </button>
                <select
                  className="header-select"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={chat.busy}
                  title="选择模型"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
                <div className="header-select-group">
                  <span className="header-select-icon" title="选择助手角色/提示词模板">🎭</span>
                  <select
                    className="header-select"
                    value={promptTemplateId}
                    onChange={(e) => setPromptTemplateId(e.target.value)}
                    disabled={chat.busy}
                    title={PROMPT_TEMPLATES.find((t) => t.id === promptTemplateId)?.description}
                  >
                    {PROMPT_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                {chat.busy && (
                  <button className="btn btn-stop" onClick={chat.stop} title="停止生成">
                    ■ Stop
                  </button>
                )}
              </div>
            </header>

            {isDragging && (
              <div className="drop-overlay">
                <div className="drop-overlay-card">
                  <div className="drop-overlay-icon">📁</div>
                  <div>Drop files to attach</div>
                </div>
              </div>
            )}

            {view === 'workspace' ? (
              <WorkspaceView onRunTask={handleRunTask} />
            ) : (
              <>
                <MessageList
                  messages={chat.messages}
                  onDecide={onDecide}
                  examples={examples}
                  busy={chat.busy}
                  onRegenerate={chat.regenerate}
                  onEditFrom={(id) => {
                    const text = chat.editFrom(id)
                    if (text !== null) {
                      setDraft(text)
                      composerRef.current?.focus()
                    }
                  }}
                  onPreview={setPreviewPath}
                  onPickExample={(p) => {
                    setDraft(p)
                    composerRef.current?.focus()
                  }}
                />

                {error && <div className="error-bar">{error}</div>}

                <Composer
                  ref={composerRef}
                  value={draft}
                  onChange={setDraft}
                  onSend={chat.send}
                  onPickFile={() => setShowFilePicker(true)}
                  disabled={chat.busy}
                />

                <FilePickerModal
                  open={showFilePicker}
                  onClose={() => setShowFilePicker(false)}
                  onSelect={insertPath}
                  onSelectDir={insertDir}
                />
              </>
            )}
          </main>

          <aside className="sidebar sidebar-right">
            <div className="sidebar-head sidebar-head-title">Runtime</div>
            <div className="runtime">
              <details className="runtime-section" open>
                <summary>
                  Tools (
                  {
                    tools.filter((t) => !mcp.servers.some((s) => t.name.startsWith(`${s.id}:`)))
                      .length
                  }
                  )
                </summary>
                <div
                  className="runtime-chips"
                  title={tools
                    .map((t) => `${t.name}${t.needsApproval ? ' (needs approval)' : ''}`)
                    .join(', ')}
                >
                  {tools.length === 0 && <span className="runtime-empty">none</span>}
                  {tools
                    .filter((t) => !mcp.servers.some((s) => t.name.startsWith(`${s.id}:`)))
                    .map((t) => (
                      <span
                        key={t.name}
                        className={t.needsApproval ? 'tool-chip tool-chip-gated' : 'tool-chip'}
                      >
                        {t.name}
                        {t.needsApproval ? ' ⚠' : ''}
                      </span>
                    ))}
                </div>
              </details>
              <details className="runtime-section" open>
                <summary>Skills ({skills.length})</summary>
                <div className="runtime-list">
                  {skills.length === 0 && <span className="runtime-empty">none</span>}
                  {skills.map((s) => (
                    <div key={s.name} className="skill-item">
                      <span
                        className="skill-chip"
                        onClick={() => setOpenSkill(openSkill === s.name ? null : s.name)}
                      >
                        {s.name}
                      </span>
                      {openSkill === s.name && <div className="skill-desc">{s.description}</div>}
                    </div>
                  ))}
                </div>
              </details>
              <details className="runtime-section" open>
                <summary>MCP Servers ({mcp.servers.length})</summary>
                <div className="runtime-list">
                  {mcp.servers.length === 0 && <span className="runtime-empty">none</span>}
                  {mcp.servers.map((s) => (
                    <div key={s.id} className="mcp-item">
                      <div
                        className="mcp-head mcp-head-clickable"
                        onClick={() => setOpenMcp(openMcp === s.id ? null : s.id)}
                        title="click to show tools"
                      >
                        <span className={`mcp-dot mcp-dot-${s.status}`} />
                        <span className="mcp-id">{s.id}</span>
                        <span className="mcp-meta">
                          {s.transport} · {s.toolCount} tools
                        </span>
                        <button
                          className="mcp-remove"
                          title="edit server"
                          onClick={(e) => {
                            e.stopPropagation()
                            mcp.startEdit(s)
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="mcp-remove"
                          title="disconnect server"
                          onClick={(e) => {
                            e.stopPropagation()
                            void mcp.remove(s.id)
                          }}
                        >
                          ×
                        </button>
                      </div>
                      {openMcp === s.id && s.tools && s.tools.length > 0 && (
                        <div className="mcp-tools">
                          {s.tools.map((t) => (
                            <span key={t} className="mcp-tool">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      {s.status === 'error' && <div className="mcp-error">{s.error}</div>}
                    </div>
                  ))}
                  {mcp.showForm ? (
                    <div className="mcp-form">
                      <div className="mcp-form-title">
                        {mcp.editId ? `Edit ${mcp.editId}` : 'Add server'}
                      </div>
                      <input
                        className="mcp-input"
                        placeholder="id (e.g. fs)"
                        value={mcp.id}
                        disabled={!!mcp.editId}
                        onChange={(e) => mcp.setId(e.target.value)}
                      />
                      <select
                        className="mcp-input"
                        value={mcp.transport}
                        onChange={(e) => mcp.setTransport(e.target.value as 'stdio' | 'http')}
                      >
                        <option value="stdio">stdio</option>
                        <option value="http">http</option>
                      </select>
                      {mcp.transport === 'stdio' ? (
                        <>
                          <input
                            className="mcp-input"
                            placeholder="command (e.g. npx)"
                            value={mcp.command}
                            onChange={(e) => mcp.setCommand(e.target.value)}
                          />
                          <input
                            className="mcp-input"
                            placeholder="args (space separated)"
                            value={mcp.args}
                            onChange={(e) => mcp.setArgs(e.target.value)}
                          />
                        </>
                      ) : (
                        <input
                          className="mcp-input"
                          placeholder="url (https://…/mcp)"
                          value={mcp.url}
                          onChange={(e) => mcp.setUrl(e.target.value)}
                        />
                      )}
                      <label className="mcp-opt">
                        <input
                          type="checkbox"
                          checked={mcp.noApproval}
                          onChange={(e) => mcp.setNoApproval(e.target.checked)}
                        />
                        read-only (no approval)
                      </label>
                      <div className="mcp-form-actions">
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => void mcp.submit()}
                        >
                          {mcp.editId ? 'Save' : 'Connect'}
                        </button>
                        <button className="btn btn-sm" onClick={mcp.cancelForm}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button className="btn btn-sm btn-add" onClick={() => mcp.setShowForm(true)}>
                      + Add server
                    </button>
                  )}
                </div>
              </details>
              <details className="runtime-section">
                <summary>Memory ({memory.count})</summary>
                <div className="runtime-list">
                  <div className="memory-add">
                    <input
                      className="mcp-input"
                      placeholder="Remember: e.g. user prefers concise answers"
                      value={memoryInput}
                      onChange={(e) => setMemoryInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && memoryInput.trim()) {
                          memory.add(memoryInput)
                          setMemoryInput('')
                        }
                      }}
                    />
                    <button
                      className="btn btn-sm btn-add"
                      onClick={() => {
                        if (memoryInput.trim()) {
                          memory.add(memoryInput)
                          setMemoryInput('')
                        }
                      }}
                    >
                      Add
                    </button>
                  </div>
                  {memory.items.length === 0 && (
                    <span className="runtime-empty">no memories yet</span>
                  )}
                  {memory.items.map((m) => (
                    <div key={m.id} className="memory-item">
                      <span className="memory-text">{m.content}</span>
                      <button
                        className="session-delete"
                        title="forget"
                        onClick={() => memory.remove(m.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {memory.items.length > 0 && (
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        if (window.confirm('Clear all memories?')) memory.clear()
                      }}
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </details>
            </div>
          </aside>
          {exportToast && <div className="toast">{exportToast}</div>}
          {previewPath && <FilePreview path={previewPath} onClose={() => setPreviewPath(null)} />}
        </>
      )}
    </div>
  )
}
