import { useCallback, useEffect, useRef, useState } from 'react'
import { addMcpServer, fetchMcpServers, removeMcpServer, type McpServerInfo } from '../api'

export interface UseMcpOptions {
  /** Called after the server list changes (add/remove) so callers can refresh
   *  derived data like the tools list / examples. */
  onToolsChanged?: () => void | Promise<void>
}

// `make dev` starts the backend (8787) and the vite frontend together; the page
// can render before the MCP servers finish connecting, so the first fetch may
// legitimately return an empty list. Poll a few times before giving up, instead
// of showing "none" and requiring a manual refresh.
const RETRY_DELAY_MS = 1500
const MAX_RETRIES = 10

/**
 * MCP server management hook.
 *
 * Owns the server list, the add/edit form state, and the connect/disconnect
 * actions. Extracted from App.tsx so the chat component doesn't also have to
 * manage MCP form fields.
 */
export function useMcp(options: UseMcpOptions = {}) {
  const { onToolsChanged } = options
  const [servers, setServers] = useState<McpServerInfo[]>([])
  // False until the initial fetchMcpServers resolves. The runtime sidebar uses
  // this to avoid a first-frame race where tools load before servers: without
  // the server list, MCP tools (fs:*/serena:*...) would be shown as plain tools.
  const [loaded, setLoaded] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [noApproval, setNoApproval] = useState(false)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    let list: McpServerInfo[] = []
    try {
      list = await fetchMcpServers()
    } catch {
      list = []
    }
    setServers(list)
    if (list.length === 0 && retryCountRef.current < MAX_RETRIES) {
      // Backend may still be connecting (make dev race) — try again shortly.
      retryCountRef.current += 1
      retryTimerRef.current = setTimeout(() => void refresh(), RETRY_DELAY_MS)
      return // keep loaded=false so the UI shows "loading…"
    }
    retryCountRef.current = 0
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    }
  }, [refresh])

  const resetForm = useCallback(() => {
    setShowForm(false)
    setEditId(null)
    setId('')
    setCommand('')
    setArgs('')
    setUrl('')
    setNoApproval(false)
  }, [])

  const submit = useCallback(async () => {
    if (!id.trim()) return
    const server = await addMcpServer({
      id: id.trim(),
      transport,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: args
        .split(/\s+/)
        .map((a) => a.trim())
        .filter(Boolean),
      url: transport === 'http' ? url.trim() : undefined,
      approval: noApproval ? false : undefined,
    })
    if (server) {
      setServers((prev) => [server, ...prev.filter((s) => s.id !== server.id)])
      resetForm()
      void onToolsChanged?.()
    }
  }, [id, transport, command, args, url, noApproval, resetForm, onToolsChanged])

  const startEdit = useCallback((s: McpServerInfo) => {
    setEditId(s.id)
    setId(s.id)
    setTransport(s.transport)
    setCommand(s.command ?? '')
    setArgs((s.args ?? []).join(' '))
    setUrl(s.url ?? '')
    setNoApproval(!s.approval)
    setShowForm(true)
  }, [])

  const remove = useCallback(async (serverId: string) => {
    const ok = await removeMcpServer(serverId)
    if (ok) {
      setServers((prev) => prev.filter((s) => s.id !== serverId))
      void onToolsChanged?.()
    }
  }, [onToolsChanged])

  return {
    servers,
    setServers,
    loaded,
    showForm,
    setShowForm,
    editId,
    id,
    setId,
    transport,
    setTransport,
    command,
    setCommand,
    args,
    setArgs,
    url,
    setUrl,
    noApproval,
    setNoApproval,
    submit,
    startEdit,
    cancelForm: resetForm,
    remove,
    refresh,
  }
}
