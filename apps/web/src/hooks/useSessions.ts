import { useCallback, useEffect, useMemo, useState } from 'react'
import { clearAllSessions, deleteSession, fetchSessions, loadSession, saveSession } from '../api'
import type { SessionMeta, UIMessage } from '../types'

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function deriveTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content ?? ''
  const t = first.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 40) : 'Untitled'
}

/** Stable, total order for the session list: newest updatedAt first, ties
 *  broken by id. Keeps the sidebar order deterministic (never a random shuffle
 *  from async save races) and consistent with the backend's sort. */
function byUpdatedDesc(a: SessionMeta, b: SessionMeta): number {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  return a.updatedAt < b.updatedAt ? 1 : -1
}

/** Persisted shape: text content + reasoning + tool-call history (survives reload). */
export function toStored(messages: UIMessage[]) {
  return messages
    .filter((m) => m.content || m.reasoning || (m.toolCalls && m.toolCalls.length > 0))
    .map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.toolCalls && m.toolCalls.length ? { toolCalls: m.toolCalls } : {}),
    }))
}

export type StoredMessage = ReturnType<typeof toStored>[number]

/**
 * Session management hook.
 *
 * Owns the session list, the active session id, and CRUD operations (load /
 * save / delete / clear). The caller is responsible for triggering saves when
 * the conversation changes (see the auto-save effect in App.tsx).
 */
export function useSessions() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setSessions((await fetchSessions()).slice().sort(byUpdatedDesc))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const upsertMeta = useCallback(
    (rec: {
      id: string
      title: string
      createdAt: string
      updatedAt: string
      messages: { length: number }
    }) => {
      // Merge the upserted record, then sort by updatedAt so the active
      // conversation rises to the top deterministically (no head-insert race).
      setSessions((prev) =>
        [
          {
            id: rec.id,
            title: rec.title,
            createdAt: rec.createdAt,
            updatedAt: rec.updatedAt,
            messageCount: rec.messages.length,
          },
          ...prev.filter((s) => s.id !== rec.id),
        ].sort(byUpdatedDesc),
      )
    },
    [],
  )

  const save = useCallback(
    async (id: string, messages: UIMessage[]) => {
      const rec = await saveSession(id, deriveTitle(messages), toStored(messages))
      upsertMeta(rec)
      return rec
    },
    [upsertMeta],
  )

  /** Ensure the conversation has a session id; create one if missing. */
  const ensureSession = useCallback(
    (messages: UIMessage[], currentId: string | null): string | null => {
      if (currentId || !messages.length) return currentId
      const id = uid()
      setSessionId(id)
      void save(id, messages)
      return id
    },
    [save],
  )

  const select = useCallback(async (id: string): Promise<StoredMessage[] | null> => {
    const rec = await loadSession(id)
    if (!rec) return null
    setSessionId(rec.id)
    return rec.messages as StoredMessage[]
  }, [])

  const remove = useCallback(
    async (id: string) => {
      await deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (sessionId === id) setSessionId(null)
    },
    [sessionId],
  )

  const clearAll = useCallback(async () => {
    await clearAllSessions()
    setSessions([])
    setSessionId(null)
  }, [])

  return useMemo(
    () => ({
      sessions,
      sessionId,
      setSessionId,
      refresh,
      save,
      ensureSession,
      select,
      remove,
      clearAll,
    }),
    [sessions, sessionId, refresh, save, ensureSession, select, remove, clearAll],
  )
}
