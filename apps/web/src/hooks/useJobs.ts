import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelJob,
  createJob,
  deleteJob,
  fetchJob,
  fetchJobFiles,
  fetchJobs,
  resumeJob,
  streamJob,
  type CreateJobInput,
} from '../api'
import type { JobEvent, JobFile, JobMeta, JobRecord, UIMessage } from '../types'

/**
 * Reduce a job's append-only event log into the same UIMessage transcript the
 * chat view renders (user prompt → thinking → tool cards → answer). Kept as a
 * pure function so both the initial detail load and live stream appends go
 * through one code path.
 */
export function jobEventsToMessages(
  job: Pick<JobRecord, 'prompt'>,
  events: JobEvent[],
): UIMessage[] {
  const messages: UIMessage[] = [{ id: 'job-user', role: 'user', content: job.prompt }]
  let assistant: UIMessage | null = null
  let hasDelta = false
  const toolMap = new Map<string, NonNullable<UIMessage['toolCalls']>[number]>()

  const ensureAssistant = (): UIMessage => {
    // Read through a fully-typed local: TS doesn't track that this closure
    // reassigns the captured `assistant`, so without the annotation it would
    // narrow the captured `null` initializer to `never`.
    const current: UIMessage | null = assistant
    if (current) return current
    const msg: UIMessage = {
      id: `job-assistant-${messages.length}`,
      role: 'assistant',
      content: '',
      toolCalls: [],
      pending: true,
    }
    assistant = msg
    messages.push(msg)
    return msg
  }

  for (const ev of events) {
    switch (ev.type) {
      case 'tool-call': {
        const a = ensureAssistant()
        const entry: NonNullable<UIMessage['toolCalls']>[number] = {
          id: ev.call.id,
          name: ev.call.name,
          arguments: ev.call.arguments,
          ...(ev.call.approvalSkipped !== undefined
            ? { approvalSkipped: ev.call.approvalSkipped }
            : {}),
        }
        toolMap.set(ev.call.id, entry)
        a.toolCalls = [...toolMap.values()]
        break
      }
      case 'tool-result': {
        const e = toolMap.get(ev.call.id)
        if (e) {
          e.result = ev.result
          e.ok = ev.ok
          e.durationMs = ev.durationMs
          e.awaitingApproval = false
        }
        break
      }
      case 'tool-progress': {
        const e = toolMap.get(ev.id)
        if (e) e.progress = (e.progress ?? '') + ev.chunk
        break
      }
      case 'approval-request': {
        const a = ensureAssistant()
        const existing = toolMap.get(ev.call.id) ?? {
          id: ev.call.id,
          name: ev.call.name,
          arguments: ev.call.arguments,
        }
        toolMap.set(ev.call.id, { ...existing, awaitingApproval: true })
        a.toolCalls = [...toolMap.values()]
        break
      }
      case 'delta': {
        hasDelta = true
        ensureAssistant().content += ev.text
        break
      }
      case 'reasoning': {
        const a = ensureAssistant()
        a.reasoning = (a.reasoning ?? '') + ev.text
        break
      }
      case 'step': {
        // The `step` event carries the same full content as the streamed
        // deltas; once we've seen a delta, skip step appends to avoid doubling.
        if (hasDelta) break
        const text = (ev.step.message.content ?? '').trim()
        if (text) ensureAssistant().content += text
        break
      }
      case 'usage':
        break
      case 'done': {
        const a = ensureAssistant()
        a.content = ev.answer
        a.pending = false
        break
      }
    }
  }
  // `pending` stays true while a run is mid-think (renders "thinking…"); the
  // terminal `done` event clears it via the case above.
  return messages
}

/**
 * Job management hook: list + CRUD + a live detail view that re-attaches to the
 * backend's SSE stream for running jobs (closing the view aborts the stream —
 * the job itself keeps running server-side).
 */
export function useJobs() {
  const [jobs, setJobs] = useState<JobMeta[]>([])
  const [selected, setSelected] = useState<JobRecord | null>(null)
  const [files, setFiles] = useState<JobFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    try {
      setJobs(await fetchJobs())
    } catch {
      /* backend down / jobs off: keep the last list */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // While any job is queued/running, poll the list so statuses stay live even
  // without opening the detail view.
  const hasActive = jobs.some((j) => j.status === 'running' || j.status === 'queued')
  useEffect(() => {
    if (!hasActive) return
    const t = setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [hasActive, refresh])

  const create = useCallback(
    async (input: CreateJobInput) => {
      setError(null)
      try {
        const job = await createJob(input)
        await refresh()
        return job
      } catch (e) {
        setError((e as Error).message)
        throw e
      }
    },
    [refresh],
  )

  const cancel = useCallback(
    async (id: string) => {
      await cancelJob(id)
      await refresh()
    },
    [refresh],
  )

  const close = useCallback(() => {
    streamRef.current?.abort()
    streamRef.current = null
    setSelected(null)
  }, [])

  const remove = useCallback(
    async (id: string) => {
      if (selected?.id === id) close()
      await deleteJob(id)
      await refresh()
    },
    [selected?.id, close, refresh],
  )

  const open = useCallback(async (id: string) => {
    streamRef.current?.abort()
    setSelected(null)
    setFiles([])
    const job = await fetchJob(id)
    if (!job) return
    setSelected(job)
    // Surface the job's workspace artifacts (reports / generated files) so the
    // detail view can list & preview intermediate outputs.
    try {
      setFiles(await fetchJobFiles(id))
    } catch {
      /* jobs off / no workspace */
    }
    if (job.status === 'running' || job.status === 'queued') {
      // Re-fetch the record a beat after the last `done` event so the terminal
      // status (succeeded/failed/cancelled) has settled server-side.
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      const ac = streamJob(id, (ev) => {
        setSelected((prev) => {
          if (!prev) return prev
          if (ev.type === 'snapshot') {
            return { ...prev, status: ev.status, events: ev.events }
          }
          if (prev.events.some((e) => e.seq === ev.seq)) return prev
          return { ...prev, events: [...prev.events, ev] }
        })
        if (ev.type === 'done') {
          if (settleTimer) clearTimeout(settleTimer)
          settleTimer = setTimeout(() => {
            void fetchJob(id).then((fresh) => {
              if (fresh) setSelected(fresh)
            })
            // Artifacts may have appeared while running — refresh them.
            void fetchJobFiles(id)
              .then(setFiles)
              .catch(() => {})
          }, 500)
        }
      })
      streamRef.current = ac
    }
  }, [])

  /** Resume an interrupted/failed job from its transcript (same workspace). */
  const resume = useCallback(
    async (id: string, instruction?: string) => {
      setError(null)
      const ok = await resumeJob(id, instruction)
      if (ok) await open(id)
      else setError('resume failed: job is not resumable (still running / missing)')
      await refresh()
      return ok
    },
    [open, refresh],
  )

  // Rebuild the transcript whenever the selected job's event log changes.
  const messages = useMemo(
    () => (selected ? jobEventsToMessages(selected, selected.events) : []),
    [selected],
  )

  useEffect(() => () => streamRef.current?.abort(), [])

  return {
    jobs,
    selected,
    messages,
    files,
    error,
    refresh,
    create,
    cancel,
    remove,
    open,
    close,
    resume,
  }
}
