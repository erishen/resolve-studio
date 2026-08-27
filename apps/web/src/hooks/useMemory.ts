import { useCallback, useEffect, useState } from 'react'

export interface MemoryItem {
  id: string
  content: string
  createdAt: number
}

const STORAGE_KEY = 'harness-memory'

function load(): MemoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function save(items: MemoryItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    /* storage full / disabled */
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Long-term memory hook. Stores user preferences / facts in localStorage so
 * they persist across sessions. The combined memory text is meant to be
 * appended to the system prompt so the agent remembers context across chats.
 */
export function useMemory() {
  const [items, setItems] = useState<MemoryItem[]>(() => load())

  useEffect(() => {
    save(items)
  }, [items])

  const add = useCallback((content: string) => {
    const trimmed = content.trim()
    if (!trimmed) return
    setItems((prev) => [{ id: uid(), content: trimmed, createdAt: Date.now() }, ...prev])
  }, [])

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const clear = useCallback(() => setItems([]), [])

  /** All memory items joined into a single block for the system prompt. */
  const systemPrompt = items.length
    ? `## Long-term memory (facts about the user / project, persist across sessions)\n${items.map((m) => `- ${m.content}`).join('\n')}`
    : ''

  return { items, add, remove, clear, systemPrompt, count: items.length }
}
