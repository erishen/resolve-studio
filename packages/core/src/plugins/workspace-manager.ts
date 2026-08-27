/**
 * Workspace manager — owns the workspace-analysis scan lifecycle.
 *
 * Extracted from `web-server.ts`. The `workspace-scan.mjs` generator writes a
 * `projects.json` report + `index.html` + a `.scan-status.json` progress file
 * into `outDir`. This module reads those artifacts, spawns background scans
 * (full or single-project), and stops a running scan.
 *
 * The two rescan paths (full vs. single-project) were previously ~60 lines of
 * near-duplicate code in the HTTP handler. They share the same "is a scan
 * already running? / clear stale flag / spawn detached / write status" flow,
 * so they're merged into {@link WorkspaceManager.startScan} here.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WorkspaceManagerConfig {
  /** Directory containing projects.json, index.html, .scan-status.json. */
  outDir: string
  /** Absolute path to workspace-scan.mjs. */
  scriptPath: string
  /** Path to the `uv` binary used by the scan script to run serena. */
  serenaUv: string
  /** Working directory for the scan child process (typically packages/core). */
  cwd: string
}

export interface ScanResult {
  started: boolean
  pid?: number
  key?: string
  error?: string
  /** True when another scan is already running (HTTP 409). */
  conflict?: boolean
}

type Logger = (level: string, msg: string, ...args: unknown[]) => void

export class WorkspaceManager {
  constructor(
    private readonly cfg: WorkspaceManagerConfig,
    private readonly log: Logger,
  ) {}

  // ---- read artifacts ----

  async getProjects(): Promise<{ generatedAt: string | null; projects: unknown[] }> {
    try {
      const raw = JSON.parse(await readFile(join(this.cfg.outDir, 'projects.json'), 'utf8'))
      // Tolerate both { generatedAt, projects } and a bare array.
      if (Array.isArray(raw)) return { generatedAt: null, projects: raw }
      return { generatedAt: raw.generatedAt ?? null, projects: raw.projects ?? [] }
    } catch {
      return { generatedAt: null, projects: [] }
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(join(this.cfg.outDir, '.scan-status.json'), 'utf8'))
    } catch {
      return { status: 'idle' }
    }
  }

  async getReport(): Promise<Buffer | null> {
    try {
      return await readFile(join(this.cfg.outDir, 'index.html'))
    } catch {
      return null
    }
  }

  // ---- scan control ----

  async rescan(force: boolean): Promise<ScanResult> {
    const guard = await this.guardRunning()
    if (guard.conflict) return guard
    const env: Record<string, string> = { ...(force ? { FORCE: '1' } : {}) }
    return this.startScan(env, {
      status: 'running',
      startedAt: new Date().toISOString(),
      total: 0,
      current: 0,
      currentKey: '',
      processed: [],
    })
  }

  async rescanProject(key: string): Promise<ScanResult> {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      return { started: false, error: 'invalid project key' }
    }
    const guard = await this.guardRunning()
    if (guard.conflict) return guard
    return this.startScan(
      { SCAN_ONLY: key },
      {
        status: 'running',
        startedAt: new Date().toISOString(),
        total: 1,
        current: 0,
        currentKey: key,
        processed: [],
      },
      key,
    )
  }

  async stop(): Promise<{ stopped: boolean; error?: string }> {
    try {
      const st = await this.getStatus()
      if (st.status !== 'running') {
        return { stopped: false, error: 'no scan running' }
      }
      const pid = st.pid as number | undefined
      if (typeof pid !== 'number' || !this.isAlive(pid)) {
        // Stale 'running' flag with no live process — clear it.
        await this.writeStatus({ status: 'terminated', finishedAt: new Date().toISOString() })
        return { stopped: false, error: 'scan process already gone (stale status cleared)' }
      }
      process.kill(pid, 'SIGTERM')
      return { stopped: true }
    } catch {
      return { stopped: false, error: 'no scan status found' }
    }
  }

  // ---- internals ----

  /** Check whether a scan is currently running. Clears a stale 'running' flag
   *  (process dead) and returns `{ conflict: true }` when a live scan exists. */
  private async guardRunning(): Promise<ScanResult> {
    let running = false
    let stale = false
    try {
      const st = await this.getStatus()
      if (st.status === 'running') {
        const pid = st.pid as number | undefined
        if (typeof pid === 'number' && this.isAlive(pid)) running = true
        else stale = true
      }
    } catch {
      /* no status file → not running */
    }
    if (stale) {
      // Clear the stale flag; the new spawn below overwrites the status file.
      try {
        await this.writeStatus({ status: 'terminated', finishedAt: new Date().toISOString() })
      } catch {
        /* ignore */
      }
    }
    if (running) {
      return { started: false, conflict: true, error: 'a scan is already running' }
    }
    return { started: false }
  }

  private async startScan(
    extraEnv: Record<string, string>,
    statusPayload: Record<string, unknown>,
    key?: string,
  ): Promise<ScanResult> {
    try {
      const child = spawn(process.execPath, [this.cfg.scriptPath], {
        cwd: this.cfg.cwd,
        env: {
          ...process.env,
          PATH: `${process.env.PATH ?? ''}:${join(homedir(), 'go', 'bin')}`,
          SERENA_UV: this.cfg.serenaUv,
          ...extraEnv,
        },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
      await this.writeStatus({ ...statusPayload, pid: child.pid })
      this.log('info', 'workspace scan started (pid=%s%s)', child.pid, key ? `, key=${key}` : '')
      return { started: true, pid: child.pid, key }
    } catch (err) {
      return { started: false, error: (err as Error).message }
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async writeStatus(status: Record<string, unknown>): Promise<void> {
    await writeFile(join(this.cfg.outDir, '.scan-status.json'), JSON.stringify(status))
  }
}
