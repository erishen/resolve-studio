import type { ChatEvent, ModelInfo, ModelsResponse, SessionMeta, SessionRecord, ToolSchema } from './types'

/** A skill exposed by the runtime. */
export interface SkillInfo {
  name: string
  description: string
}

/** Fetch the available skills (name + description). */
export async function fetchSkills(): Promise<SkillInfo[]> {
  const res = await fetch('/api/skills')
  if (!res.ok) return []
  const data = (await res.json()) as { skills: SkillInfo[] }
  return data.skills ?? []
}

// ---- Filesystem browser (sandboxed to the backend's read roots) ----

export interface FsEntry {
  name: string
  /** Absolute server-side path. */
  path: string
  isDir: boolean
  size: number
}

export interface FsListing {
  /** Current directory (empty string = the root chooser view). */
  dir: string
  /** Parent directory to navigate up to, or null when already at a root. */
  parent: string | null
  /** True when `dir` is exactly a configured read root (can't go above it). */
  atRoot?: boolean
  entries: FsEntry[]
}

/** List a directory, or the configured read roots when `dir` is omitted. */
export async function fetchFs(dir?: string): Promise<FsListing> {
  const qs = dir ? `?path=${encodeURIComponent(dir)}` : ''
  const res = await fetch(`/api/fs${qs}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `failed to list directory (${res.status})`)
  }
  return (await res.json()) as FsListing
}

// ---- MCP server management ----

export interface McpServerInfo {
  id: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  approval: boolean
  status: 'connected' | 'error'
  toolCount: number
  tools?: string[]
  error?: string
}

export async function fetchMcpServers(): Promise<McpServerInfo[]> {
  const res = await fetch('/api/mcp')
  if (!res.ok) return []
  const data = (await res.json()) as { servers: McpServerInfo[] }
  return data.servers ?? []
}

export async function addMcpServer(cfg: {
  id: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  approval?: boolean
}): Promise<McpServerInfo | null> {
  const res = await fetch('/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { server: McpServerInfo }
  return data.server
}

export async function removeMcpServer(id: string): Promise<boolean> {
  const res = await fetch(`/api/mcp/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}

/** Resolve a pending tool approval. */
export async function approveCall(
  callId: string,
  decision: 'approve' | 'reject',
): Promise<boolean> {
  const res = await fetch('/api/approval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callId, decision }),
  })
  return res.ok
}

// ---- session persistence ----

export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch('/api/sessions')
  if (!res.ok) throw new Error(`failed to load sessions: ${res.status}`)
  const data = (await res.json()) as { sessions: SessionMeta[] }
  return data.sessions ?? []
}

export async function saveSession(
  id: string,
  title: string,
  messages: { role: string; content: string }[],
): Promise<SessionRecord> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, title, messages }),
  })
  if (!res.ok) throw new Error(`failed to save session: ${res.status}`)
  const data = (await res.json()) as { session: SessionRecord }
  return data.session
}

export async function loadSession(id: string): Promise<SessionRecord | null> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) return null
  const data = (await res.json()) as { session: SessionRecord }
  return data.session
}

export async function deleteSession(id: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return res.ok
}

/** Delete every stored session (the sidebar's "clear all" action). */
export async function clearAllSessions(): Promise<boolean> {
  const res = await fetch('/api/sessions', { method: 'DELETE' })
  return res.ok
}

/** Fetch the available tools from the runtime. */
export async function fetchTools(): Promise<ToolSchema[]> {
  const res = await fetch('/api/tools')
  if (!res.ok) throw new Error(`failed to load tools: ${res.status}`)
  const data = (await res.json()) as { tools: ToolSchema[] }
  return data.tools ?? []
}

/** Fetch the available models and the backend's default model. */
export async function fetchModels(): Promise<{ models: ModelInfo[]; defaultModel?: string }> {
  const res = await fetch('/api/models')
  if (!res.ok) throw new Error(`failed to load models: ${res.status}`)
  const data = (await res.json()) as ModelsResponse
  return { models: data.models ?? [], defaultModel: data.defaultModel }
}

/**
 * Stream a chat run as Server-Sent Events.
 *
 * `onEvent` is called for every agent event. The underlying fetch stream is
 * kept open until the run completes or errors. Pass an `AbortSignal` (from an
 * `AbortController`) to support a "Stop" button — aborting ends the stream
 * without throwing.
 */
export async function streamChat(
  messages: { role: string; content: string }[],
  model: string | undefined,
  onEvent: (ev: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, model }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`chat request failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line.
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const parsed = parseFrame(frame)
        if (parsed) onEvent(parsed)
      }
    }
  } catch (err) {
    // Aborting is an expected stop path, not an error — swallow it so the UI
    // just stops receiving events instead of showing a red error.
    if ((err as Error)?.name === 'AbortError') return
    throw err
  }

  // Flush any trailing frame.
  const tail = buffer.trim()
  if (tail) {
    const parsed = parseFrame(tail)
    if (parsed) onEvent(parsed)
  }
}

/** Fetch the current cumulative token/cost usage snapshot. */
export async function fetchUsage(): Promise<{
  totalPromptTokens: number
  totalCompletionTokens: number
  totalTokens: number
  totalCost: number
  requests: number
} | null> {
  const res = await fetch('/api/usage')
  if (!res.ok) return null
  const data = (await res.json()) as { usage: unknown }
  return (data.usage as never) ?? null
}

function parseFrame(frame: string): ChatEvent | null {
  let type = ''
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      type = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join('\n')
  try {
    const data = JSON.parse(payload) as Record<string, unknown>
    // The event name travels on the SSE `event:` line, not inside the JSON;
    // merge it in so downstream `switch (ev.type)` works.
    return { ...data, type } as ChatEvent
  } catch {
    return { type: 'error', message: `malformed frame: ${payload}` }
  }
}
