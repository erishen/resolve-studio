import { useEffect, useMemo, useRef, useState } from 'react'
import {
  approveCall,
  deleteSession,
  clearAllSessions,
  fetchModels,
  fetchSessions,
  fetchSkills,
  fetchTools,
  loadSession,
  saveSession,
  streamChat,
  addMcpServer,
  fetchMcpServers,
  removeMcpServer,
  type McpServerInfo,
} from './api'
import { Composer, type ComposerHandle } from './Composer'
import { FilePickerModal } from './FilePickerModal'
import { MessageList } from './MessageList'
import { buildExamples, FALLBACK_EXAMPLES } from './examples'
import type { ChatEvent, ModelInfo, SessionMeta, ToolSchema } from './types'
import type { SkillInfo } from './api'

interface UIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Model's thinking/judgement stream (DeepSeek reasoning_content). */
  reasoning?: string
  /** Tool calls issued by the assistant while producing this message. */
  toolCalls?: {
    /** The backend tool-call id (used to route approval decisions). */
    id?: string
    name: string
    arguments: string | Record<string, unknown>
    result?: string
    ok?: boolean
    gated?: boolean
    awaitingApproval?: boolean
    decision?: 'approve' | 'reject'
  }[]
  pending?: boolean
}

export type { UIMessage }

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Persisted shape: text content + reasoning + tool-call history (survives reload). */
function toStored(messages: UIMessage[]): { role: string; content: string; reasoning?: string; toolCalls?: UIMessage['toolCalls'] }[] {
  return messages
    .filter((m) => m.content || m.reasoning || (m.toolCalls && m.toolCalls.length > 0))
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.toolCalls && m.toolCalls.length ? { toolCalls: m.toolCalls } : {}),
    }))
}

function deriveTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content ?? ''
  const t = first.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 40) : 'Untitled'
}

export function App() {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [model, setModel] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Cumulative token/cost for the current session (reset on new chat).
  const [usage, setUsage] = useState<{ prompt: number; completion: number; cost: number }>({
    prompt: 0,
    completion: 0,
    cost: 0,
  })
  // Abort controller for the in-flight chat run (Stop button).
  const abortRef = useRef<AbortController | null>(null)

  // Composer draft (controlled) + ref so example chips can fill & focus it.
  const [draft, setDraft] = useState('')
  const composerRef = useRef<ComposerHandle>(null)
  // File-picker modal visibility.
  const [showFilePicker, setShowFilePicker] = useState(false)

  // Drop a chosen file path into the composer: if the box is empty, seed a
  // ready-to-send "read & summarize" prompt; otherwise append the path.
  const insertPath = (p: string) => {
    setDraft((d) => (d.trim() ? `${d.trim()} ${p}` : `读取 ${p} 的内容，并总结它做了什么。`))
    setShowFilePicker(false)
    composerRef.current?.focus()
  }
  // Drop a chosen directory path: seed an "analyze this directory" prompt.
  const insertDir = (p: string) => {
    setDraft((d) => (d.trim() ? `${d.trim()} ${p}` : `分析 ${p} 目录，并总结它做了什么。`))
    setShowFilePicker(false)
    composerRef.current?.focus()
  }
  // Example prompts derived from the runtime's tools & skills.
  const examples = useMemo(() => {
    const built = buildExamples(tools, skills)
    return built.length ? built : FALLBACK_EXAMPLES
  }, [tools, skills])

  // ---- MCP server management ----
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const [showMcpForm, setShowMcpForm] = useState(false)
  const [editMcpId, setEditMcpId] = useState<string | null>(null)
  const [mcpId, setMcpId] = useState('')
  const [mcpTransport, setMcpTransport] = useState<'stdio' | 'http'>('stdio')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpNoApproval, setMcpNoApproval] = useState(false)

  // ---- session persistence ----
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [openSkill, setOpenSkill] = useState<string | null>(null)
  const [openMcp, setOpenMcp] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Load models/tools/session list on mount.
  useEffect(() => {
    void (async () => {
      try {
        const [m, t, s, sk, mcp] = await Promise.all([
          fetchModels(),
          fetchTools(),
          fetchSessions(),
          fetchSkills(),
          fetchMcpServers(),
        ])
        setModels(m.models)
        setTools(t)
        setSessions(s)
        setSkills(sk)
        setMcpServers(mcp)
        // Prefer the backend's default (config.model / OPENAI_MODEL); fall back
        // to the first entry only if it isn't in the list.
        const preferred = m.defaultModel && m.models.some((x) => x.id === m.defaultModel)
          ? m.defaultModel
          : m.models[0]?.id ?? ''
        setModel(preferred)
      } catch (err) {
        setError(`failed to load runtime info: ${(err as Error).message}`)
      }
    })()
  }, [])

  // Debounced auto-save whenever the conversation changes.
  useEffect(() => {
    if (!sessionId || !messages.length) return
    const t = setTimeout(() => {
      void saveSession(sessionId, deriveTitle(messagesRef.current), toStored(messagesRef.current))
        .then((rec) => {
          setSessions((prev) => {
            const next = prev.filter((s) => s.id !== rec.id)
            return [
              { id: rec.id, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt, messageCount: rec.messages.length },
              ...next,
            ]
          })
        })
        .catch(() => {
          /* offline / backend down: skip silently */
        })
    }, 800)
    return () => clearTimeout(t)
  }, [messages, sessionId])

  const newChat = () => {
    setMessages([])
    setSessionId(null)
    setError(null)
    setUsage({ prompt: 0, completion: 0, cost: 0 })
  }

  const selectSession = async (id: string) => {
    if (busy) return
    const rec = await loadSession(id)
    if (!rec) {
      setError('session not found')
      return
    }
    setMessages(
      rec.messages.map((m) => ({
        id: uid(),
        role: m.role as 'user' | 'assistant',
        content: m.content,
        ...(m.reasoning ? { reasoning: m.reasoning } : {}),
        ...(m.toolCalls && m.toolCalls.length
          ? {
              toolCalls: m.toolCalls.map((tc) => ({
                ...tc,
                // a restored session is not waiting on a live approval
                awaitingApproval: false,
              })),
            }
          : {}),
      })),
    )
    setSessionId(rec.id)
    setError(null)
  }

  const removeSession = async (id: string) => {
    await deleteSession(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (sessionId === id) {
      setMessages([])
      setSessionId(null)
    }
  }

  // Clear every stored session (sidebar "清空全部会话"). This is destructive,
  // so we gate it behind a confirm and disable it while a run is in flight.
  const clearAll = async () => {
    if (busy) return
    if (!window.confirm('清空所有会话？此操作不可撤销。')) return
    await clearAllSessions()
    setSessions([])
    setMessages([])
    setSessionId(null)
    setError(null)
    setUsage({ prompt: 0, completion: 0, cost: 0 })
  }

  const submitMcp = async () => {
    if (!mcpId.trim()) return
    const server = await addMcpServer({
      id: mcpId.trim(),
      transport: mcpTransport,
      command: mcpTransport === 'stdio' ? mcpCommand.trim() : undefined,
      args: mcpArgs
        .split(/\s+/)
        .map((a) => a.trim())
        .filter(Boolean),
      url: mcpTransport === 'http' ? mcpUrl.trim() : undefined,
      approval: mcpNoApproval ? false : undefined,
    })
    if (server) {
      setMcpServers((prev) => [
        server,
        ...prev.filter((s) => s.id !== server.id),
      ])
      setShowMcpForm(false)
      setEditMcpId(null)
      setMcpId('')
      setMcpCommand('')
      setMcpArgs('')
      setMcpUrl('')
      setMcpNoApproval(false)
    }
  }

  const startEditMcp = (s: McpServerInfo) => {
    setEditMcpId(s.id)
    setMcpId(s.id)
    setMcpTransport(s.transport)
    setMcpCommand(s.command ?? '')
    setMcpArgs((s.args ?? []).join(' '))
    setMcpUrl(s.url ?? '')
    setMcpNoApproval(!s.approval)
    setShowMcpForm(true)
  }

  const cancelMcpForm = () => {
    setShowMcpForm(false)
    setEditMcpId(null)
    setMcpId('')
    setMcpCommand('')
    setMcpArgs('')
    setMcpUrl('')
    setMcpNoApproval(false)
  }

  const removeMcp = async (id: string) => {
    const ok = await removeMcpServer(id)
    if (ok) setMcpServers((prev) => prev.filter((s) => s.id !== id))
  }

  const handleDecision = async (callId: string, decision: 'approve' | 'reject') => {
    const ok = await approveCall(callId, decision)
    if (!ok) return
    // Mark locally; the backend will emit tool-result next (approve) or feed
    // the rejection back (reject).
    patchToolState(callId, { awaitingApproval: false, decision })
  }

  // Helper to patch a tool entry on the assistant message by call id.
  const patchToolState = (
    callId: string,
    patch: Partial<NonNullable<UIMessage['toolCalls']>[number]>,
  ) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.toolCalls
          ? { ...m, toolCalls: m.toolCalls.map((tc) => (tc.id === callId ? { ...tc, ...patch } : tc)) }
          : m,
      ),
    )
  }

  const handleSend = async (text: string) => {
    if (!text.trim() || busy) return
    setError(null)
    setBusy(true)

    const history = [
      ...messagesRef.current.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ]

    const userMsg: UIMessage = { id: uid(), role: 'user', content: text }
    const assistantId = uid()
    const assistantMsg: UIMessage = { id: assistantId, role: 'assistant', content: '', toolCalls: [], pending: true }
    setMessages((prev) => [...prev, userMsg, assistantMsg])

    // Track tool states keyed by tool call id.
    const toolStates = new Map<
      string,
      NonNullable<UIMessage['toolCalls']>[number] & { id: string }
    >()
    const isGated = (name: string) => tools.some((t) => t.name === name && t.needsApproval)

    const patchAssistant = (patch: Partial<UIMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)),
      )
    }

    // Streaming text is delivered via `delta` events; the `step` event carries
    // the same full content, so once we've seen a delta we skip step-appends
    // to avoid double text.
    let hasDelta = false

    // Abort controller lets the Stop button cancel the in-flight run.
    const ac = new AbortController()
    abortRef.current = ac

    try {
      await streamChat(history, model || undefined, (ev: ChatEvent) => {
        switch (ev.type) {
          case 'tool-call': {
            const entry = { id: ev.call.id, name: ev.call.name, arguments: ev.call.arguments, gated: isGated(ev.call.name) }
            toolStates.set(ev.call.id, entry)
            patchAssistant({ toolCalls: [...toolStates.values()] })
            break
          }
          case 'approval-request': {
            const existing = toolStates.get(ev.call.id) ?? { id: ev.call.id, name: ev.call.name, arguments: ev.call.arguments }
            toolStates.set(ev.call.id, { ...existing, awaitingApproval: true, decision: undefined })
            patchAssistant({ toolCalls: [...toolStates.values()] })
            break
          }
          case 'tool-result': {
            const existing = toolStates.get(ev.payload.call.id)
            if (existing) {
              toolStates.set(ev.payload.call.id, { ...existing, result: ev.payload.result, ok: ev.payload.ok, awaitingApproval: false })
              patchAssistant({ toolCalls: [...toolStates.values()] })
            }
            break
          }
          case 'delta': {
            hasDelta = true
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + ev.text } : m,
              ),
            )
            break
          }
          case 'reasoning': {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, reasoning: (m.reasoning ?? '') + ev.text }
                  : m,
              ),
            )
            break
          }
          case 'step': {
            if (hasDelta) break
            // Append any assistant text seen in the step. Trim it so a leading
            // newline in the model output can't render as a blank line (the
            // `done` answer below is trimmed server-side too).
            const stepText = (ev.step.message.content ?? '').trim()
            if (stepText) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + stepText } : m,
                ),
              )
            }
            break
          }
          case 'usage': {
            setUsage((u) => ({
              prompt: u.prompt + ev.record.promptTokens,
              completion: u.completion + ev.record.completionTokens,
              cost: u.cost + ev.record.cost,
            }))
            break
          }
          case 'done': {
            patchAssistant({ content: ev.answer, pending: false })
            break
          }
          case 'error': {
            setError(ev.message)
            patchAssistant({ pending: false })
            break
          }
        }
      }, ac.signal)
    } catch (err) {
      setError((err as Error).message)
      patchAssistant({ pending: false })
    } finally {
      setBusy(false)
      abortRef.current = null
      setDraft('')
      patchAssistant({ pending: false })
      // Ensure the new conversation is persisted under a session id.
      const current = messagesRef.current
      if (!sessionId && current.length) {
        const id = uid()
        setSessionId(id)
        void saveSession(id, deriveTitle(current), toStored(current)).then((rec) => {
          setSessions((prev) => [
            { id: rec.id, title: rec.title, createdAt: rec.createdAt, updatedAt: rec.updatedAt, messageCount: rec.messages.length },
            ...prev.filter((s) => s.id !== rec.id),
          ])
        })
      }
    }
  }

  const stopRun = () => {
    abortRef.current?.abort()
  }

  const onDecide = async (callId: string, decision: 'approve' | 'reject') => {
    await handleDecision(callId, decision)
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <button className="btn btn-primary" onClick={newChat} disabled={busy}>
            + New chat
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void clearAll()}
            disabled={busy || sessions.length === 0}
            title="清空所有会话（不可撤销）"
          >
            清空全部会话
          </button>
        </div>
        <div className="session-list">
          {sessions.length === 0 && <div className="session-empty">no saved sessions</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item${s.id === sessionId ? ' session-active' : ''}`}
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

      <main className="main">
        <header className="app-header">
          <div className="app-title">
            <span className="dot" />
            Agent Harness
          </div>
          <div className="app-controls">
            <span className="usage-badge" title="本会话累计 token 与估算费用（¥）">
              {usage.prompt + usage.completion} tok · ¥{usage.cost.toFixed(4)}
            </span>
            <label className="model-select">
              model
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
            </label>
            {busy && (
              <button className="btn btn-stop" onClick={stopRun} title="停止生成">
                ■ Stop
              </button>
            )}
          </div>
        </header>

        <MessageList
          messages={messages}
          onDecide={onDecide}
          examples={examples}
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
          onSend={handleSend}
          onPickFile={() => setShowFilePicker(true)}
          disabled={busy}
        />

        <FilePickerModal
          open={showFilePicker}
          onClose={() => setShowFilePicker(false)}
          onSelect={insertPath}
          onSelectDir={insertDir}
        />
      </main>

      <aside className="sidebar sidebar-right">
        <div className="sidebar-head sidebar-head-title">Runtime</div>
        <div className="runtime">
          <details className="runtime-section" open>
            <summary>Tools ({tools.filter((t) => !mcpServers.some((s) => t.name.startsWith(`${s.id}:`))).length})</summary>
            <div className="runtime-chips" title={tools.map((t) => `${t.name}${t.needsApproval ? ' (needs approval)' : ''}`).join(', ')}>
              {tools.length === 0 && <span className="runtime-empty">none</span>}
              {tools
                .filter((t) => !mcpServers.some((s) => t.name.startsWith(`${s.id}:`)))
                .map((t) => (
                  <span key={t.name} className={t.needsApproval ? 'tool-chip tool-chip-gated' : 'tool-chip'}>
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
                  {openSkill === s.name && (
                    <div className="skill-desc">{s.description}</div>
                  )}
                </div>
              ))}
            </div>
          </details>
          <details className="runtime-section" open>
            <summary>MCP Servers ({mcpServers.length})</summary>
            <div className="runtime-list">
              {mcpServers.length === 0 && <span className="runtime-empty">none</span>}
              {mcpServers.map((s) => (
                <div key={s.id} className="mcp-item">
                  <div
                    className="mcp-head mcp-head-clickable"
                    onClick={() => setOpenMcp(openMcp === s.id ? null : s.id)}
                    title="click to show tools"
                  >
                    <span className={`mcp-dot mcp-dot-${s.status}`} />
                    <span className="mcp-id">{s.id}</span>
                    <span className="mcp-meta">{s.transport} · {s.toolCount} tools</span>
                    <button
                      className="mcp-remove"
                      title="edit server"
                      onClick={(e) => {
                        e.stopPropagation()
                        startEditMcp(s)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className="mcp-remove"
                      title="disconnect server"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeMcp(s.id)
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
              {showMcpForm ? (
                <div className="mcp-form">
                  <div className="mcp-form-title">
                    {editMcpId ? `Edit ${editMcpId}` : 'Add server'}
                  </div>
                  <input
                    className="mcp-input"
                    placeholder="id (e.g. fs)"
                    value={mcpId}
                    disabled={!!editMcpId}
                    onChange={(e) => setMcpId(e.target.value)}
                  />
                  <select
                    className="mcp-input"
                    value={mcpTransport}
                    onChange={(e) => setMcpTransport(e.target.value as 'stdio' | 'http')}
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http</option>
                  </select>
                  {mcpTransport === 'stdio' ? (
                    <>
                      <input
                        className="mcp-input"
                        placeholder="command (e.g. npx)"
                        value={mcpCommand}
                        onChange={(e) => setMcpCommand(e.target.value)}
                      />
                      <input
                        className="mcp-input"
                        placeholder="args (space separated)"
                        value={mcpArgs}
                        onChange={(e) => setMcpArgs(e.target.value)}
                      />
                    </>
                  ) : (
                    <input
                      className="mcp-input"
                      placeholder="url (https://…/mcp)"
                      value={mcpUrl}
                      onChange={(e) => setMcpUrl(e.target.value)}
                    />
                  )}
                  <label className="mcp-opt">
                    <input
                      type="checkbox"
                      checked={mcpNoApproval}
                      onChange={(e) => setMcpNoApproval(e.target.checked)}
                    />
                    read-only (no approval)
                  </label>
                  <div className="mcp-form-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => void submitMcp()}>
                      {editMcpId ? 'Save' : 'Connect'}
                    </button>
                    <button className="btn btn-sm" onClick={cancelMcpForm}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-sm btn-add" onClick={() => setShowMcpForm(true)}>
                  + Add server
                </button>
              )}
            </div>
          </details>
        </div>
      </aside>
    </div>
  )
}
