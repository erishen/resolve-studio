import { useCallback, useRef, useState } from 'react'
import { approveCall, streamChat } from '../api'
import type { ChatEvent, ToolSchema, UIMessage } from '../types'

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export interface UseChatOptions {
  tools: ToolSchema[]
  model: string
  sessionId: string | null
  systemPrompt?: string
  /** Called after a run finishes (success or error) so the caller can persist
   *  the conversation / create a session id. */
  onRunComplete?: (messages: UIMessage[]) => void
}

/**
 * Chat hook — owns the conversation state and the send/stop/approval flow.
 *
 * Extracted from App.tsx. Handles streaming SSE events, tool-call state
 * tracking, usage accumulation, and the abort controller for the Stop button.
 * Session persistence is delegated to the caller via `onRunComplete`.
 */
export function useChat({ tools, model, sessionId, systemPrompt, onRunComplete }: UseChatOptions) {
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usage, setUsage] = useState({ prompt: 0, completion: 0, cost: 0 })
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // Keep latest values in refs so `send` doesn't need them in its dep array
  // (re-creating `send` on every sessionId change would break the composer's
  // onSend reference and cause unnecessary re-renders).
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const systemPromptRef = useRef(systemPrompt)
  systemPromptRef.current = systemPrompt
  const onCompleteRef = useRef(onRunComplete)
  onCompleteRef.current = onRunComplete

  const patchToolState = useCallback(
    (callId: string, patch: Partial<NonNullable<UIMessage['toolCalls']>[number]>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.toolCalls
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) => (tc.id === callId ? { ...tc, ...patch } : tc)),
              }
            : m,
        ),
      )
    },
    [],
  )

  const handleDecision = useCallback(
    async (callId: string, decision: 'approve' | 'reject') => {
      const ok = await approveCall(callId, decision)
      if (!ok) return
      // Mark locally; the backend will emit tool-result next (approve) or feed
      // the rejection back (reject).
      patchToolState(callId, { awaitingApproval: false, decision })
    },
    [patchToolState],
  )

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || busy) return
      setError(null)
      setBusy(true)

      const history = [
        ...messagesRef.current.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: text },
      ]

      const userMsg: UIMessage = { id: uid(), role: 'user', content: text }
      const assistantId = uid()
      const assistantMsg: UIMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        pending: true,
      }
      setMessages((prev) => [...prev, userMsg, assistantMsg])

      // Track tool states keyed by tool call id.
      const toolStates = new Map<
        string,
        NonNullable<UIMessage['toolCalls']>[number] & { id: string }
      >()
      const isGated = (name: string) => tools.some((t) => t.name === name && t.needsApproval)

      const patchAssistant = (patch: Partial<UIMessage>) => {
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)))
      }

      // Streaming text is delivered via `delta` events; the `step` event carries
      // the same full content, so once we've seen a delta we skip step-appends
      // to avoid double text.
      let hasDelta = false

      const ac = new AbortController()
      abortRef.current = ac

      try {
        await streamChat(
          history,
          model || undefined,
          (ev: ChatEvent) => {
            switch (ev.type) {
              case 'tool-call': {
                const entry = {
                  id: ev.call.id,
                  name: ev.call.name,
                  arguments: ev.call.arguments,
                  gated: isGated(ev.call.name),
                }
                toolStates.set(ev.call.id, entry)
                patchAssistant({ toolCalls: [...toolStates.values()] })
                break
              }
              case 'approval-request': {
                const existing = toolStates.get(ev.call.id) ?? {
                  id: ev.call.id,
                  name: ev.call.name,
                  arguments: ev.call.arguments,
                }
                toolStates.set(ev.call.id, {
                  ...existing,
                  awaitingApproval: true,
                  decision: undefined,
                })
                patchAssistant({ toolCalls: [...toolStates.values()] })
                break
              }
              case 'tool-result': {
                const existing = toolStates.get(ev.payload.call.id)
                if (existing) {
                  toolStates.set(ev.payload.call.id, {
                    ...existing,
                    result: ev.payload.result,
                    ok: ev.payload.ok,
                    awaitingApproval: false,
                    durationMs: ev.payload.durationMs,
                  })
                  patchAssistant({ toolCalls: [...toolStates.values()] })
                }
                break
              }
              case 'tool-progress': {
                const existing = toolStates.get(ev.payload.id)
                if (existing) {
                  toolStates.set(ev.payload.id, {
                    ...existing,
                    progress: (existing.progress ?? '') + ev.payload.chunk,
                  })
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
                    m.id === assistantId ? { ...m, reasoning: (m.reasoning ?? '') + ev.text } : m,
                  ),
                )
                break
              }
              case 'step': {
                if (hasDelta) break
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
          },
          ac.signal,
          sessionIdRef.current ?? undefined,
          systemPromptRef.current || undefined,
        )
      } catch (err) {
        setError((err as Error).message)
        patchAssistant({ pending: false })
      } finally {
        setBusy(false)
        abortRef.current = null
        patchAssistant({ pending: false })
        onCompleteRef.current?.(messagesRef.current)
      }
    },
    [busy, tools, model],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    setMessages([])
    setError(null)
    setUsage({ prompt: 0, completion: 0, cost: 0 })
  }, [])

  /**
   * Regenerate from the last user message: truncate everything after it and
   * re-send. No-op when busy or when there is no user message to replay.
   */
  const regenerate = useCallback(() => {
    if (busy) return
    const msgs = messagesRef.current
    const lastUserIdx = [...msgs].reverse().findIndex((m) => m.role === 'user')
    if (lastUserIdx === -1) return
    const lastUser = msgs[msgs.length - 1 - lastUserIdx]
    const truncated = msgs.slice(0, msgs.length - lastUserIdx)
    setMessages(truncated)
    // Defer the send so state update flushes first (send reads messagesRef).
    setTimeout(() => send(lastUser.content), 0)
  }, [busy, send])

  /**
   * Truncate the conversation to just before the given user message and return
   * its content so the caller can drop it into the composer for editing. The
   * caller is responsible for calling `send` with the edited text.
   */
  const editFrom = useCallback(
    (messageId: string): string | null => {
      if (busy) return null
      const msgs = messagesRef.current
      const idx = msgs.findIndex((m) => m.id === messageId)
      if (idx === -1 || msgs[idx].role !== 'user') return null
      const content = msgs[idx].content
      setMessages(msgs.slice(0, idx))
      return content
    },
    [busy],
  )

  const setMessagesDirect = useCallback((msgs: UIMessage[]) => {
    setMessages(msgs)
  }, [])

  return {
    messages,
    setMessages: setMessagesDirect,
    busy,
    error,
    setError,
    usage,
    send,
    stop,
    reset,
    regenerate,
    editFrom,
    handleDecision,
    patchToolState,
  }
}
