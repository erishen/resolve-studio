/**
 * Session store — persists web UI conversations as JSON files on disk.
 *
 * Extracted from `web-server.ts` so the HTTP plugin doesn't also own the
 * storage layer. A session is the frontend's conversation history (messages,
 * tool calls, reasoning); the frontend auto-saves it (debounced) via
 * POST /api/sessions.
 *
 * Storage layout: `<dir>/<sanitized-id>.json`. All writes are atomic
 * (write-to-temp + rename) so a crash mid-write can't corrupt an existing
 * session file.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SessionRecord extends Omit<SessionMeta, 'messageCount'> {
  messages: {
    role: string
    content: string
    toolCalls?: {
      id?: string
      name: string
      arguments: unknown
      result?: string
      ok?: boolean
      gated?: boolean
      decision?: string
    }[]
  }[]
}

/** Strip anything that isn't a safe filename char — guards against path
 *  traversal via client-supplied session ids. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  private pathFor(id: string): string {
    return join(this.dir, `${sanitizeId(id)}.json`)
  }

  async list(): Promise<SessionMeta[]> {
    await this.ensureDir()
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as SessionRecord
        metas.push({
          id: rec.id,
          title: rec.title,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          messageCount: rec.messages?.length ?? 0,
        })
      } catch {
        // skip corrupt files
      }
    }
    return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async get(id: string): Promise<SessionRecord | null> {
    const safe = sanitizeId(id)
    if (!safe) return null
    try {
      return JSON.parse(await readFile(this.pathFor(safe), 'utf8')) as SessionRecord
    } catch {
      return null
    }
  }

  async set(rec: SessionRecord): Promise<void> {
    await this.ensureDir()
    const safe = sanitizeId(rec.id)
    if (!safe) throw new Error('invalid session id')
    const target = this.pathFor(safe)
    // Atomic write: temp file + rename so a crash can't leave a half-written file.
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tmp, JSON.stringify(rec, null, 2))
    await rename(tmp, target)
  }

  async remove(id: string): Promise<boolean> {
    const safe = sanitizeId(id)
    if (!safe) return false
    try {
      await rm(this.pathFor(safe))
      return true
    } catch {
      return false
    }
  }

  async clear(): Promise<number> {
    await this.ensureDir()
    let files: string[]
    try {
      files = await readdir(this.dir)
    } catch {
      return 0
    }
    let removed = 0
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        await rm(join(this.dir, f))
        removed += 1
      } catch {
        // ignore individual failures
      }
    }
    return removed
  }
}
