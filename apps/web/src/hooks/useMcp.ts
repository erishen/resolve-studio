import { useCallback, useEffect, useState } from 'react'
import { addMcpServer, fetchMcpServers, removeMcpServer, type McpServerInfo } from '../api'

/**
 * MCP server management hook.
 *
 * Owns the server list, the add/edit form state, and the connect/disconnect
 * actions. Extracted from App.tsx so the chat component doesn't also have to
 * manage MCP form fields.
 */
export function useMcp() {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [noApproval, setNoApproval] = useState(false)

  const refresh = useCallback(async () => {
    setServers(await fetchMcpServers())
  }, [])

  useEffect(() => {
    void refresh()
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
    }
  }, [id, transport, command, args, url, noApproval, resetForm])

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
    if (ok) setServers((prev) => prev.filter((s) => s.id !== serverId))
  }, [])

  return {
    servers,
    setServers,
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
