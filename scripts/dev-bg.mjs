#!/usr/bin/env node
/**
 * Background dev launcher — `node scripts/dev-bg.mjs <cmd> [--mock]`
 *
 * Spawns the backend (tsx) and the Vite web dev server into an independent
 * session / process group (spawn detached + unref), so they keep running after
 * the launching terminal / IDE task / sandbox session is closed. Only
 * `make dev-bg-stop` (or `dev-bg.mjs stop`) tears them down.
 *
 * Mirrors the Makefile `dev` / `dev-mock` commands exactly, just persistent:
 *   backend : node --import tsx packages/core/src/index.ts --config <yml>
 *   web     : (cd apps/web && pnpm exec vite --host 127.0.0.1 --port 5173)
 *
 * Commands:
 *   start [--mock]    launch backend (real model) + web; --mock = offline config
 *   stop              kill the whole process group (TERM), no orphans left
 *   status            show pid + whether the ports are still listening
 *   restart [--mock]  stop then start (preserves --mock of the running instance)
 *
 * Convention: if a port is already in use we REFUSE to start — we do NOT pkill
 * strangers. Free the port (or `make dev-bg-stop`) first.
 */

import { spawn } from 'node:child_process'
import {
  mkdirSync,
  openSync,
  closeSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import http from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'packages', 'core')
const WEB = join(ROOT, 'apps', 'web')
const PID_DIR = join(ROOT, '.run')

const BACKEND_PORT = Number(process.env.BACKEND_PORT || 8787)
const WEB_PORT = Number(process.env.WEB_PORT || 5173)
const REAL_CONFIG = 'cordis.openai.web.yml'
const MOCK_CONFIG = 'cordis.web.yml'
const BACKEND_PROBE = process.env.BACKEND_PROBE || '/api/models'
const BACKEND_WAIT_TIMEOUT = Number(process.env.BACKEND_WAIT_TIMEOUT || 60)
const PIDS_FILE = join(PID_DIR, 'dev-bg.pids')

const hasMock = () => process.argv.includes('--mock')

// ---- helpers ---------------------------------------------------------------

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    // safety net: don't hang if the socket neither connects nor errors
    setTimeout(() => done(false), 1500).unref()
  })
}

function probeBackend() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: BACKEND_PORT, path: BACKEND_PROBE, family: 4, timeout: 2000 },
      (res) => {
        res.resume()
        resolve(true)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitBackend() {
  process.stdout.write(`waiting for backend on :${BACKEND_PORT} `)
  for (let i = 0; i < BACKEND_WAIT_TIMEOUT; i++) {
    if (await probeBackend()) {
      console.log(' ready')
      return
    }
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log(` timeout after ${BACKEND_WAIT_TIMEOUT}s (starting web anyway)`)
}

// Spawn into its own session (detached) and detach from the parent so it
// outlives this launcher. Logs go to a file fd, never to the parent pipe.
function launch(logPath, cmd, args, cwd, extraEnv) {
  mkdirSync(PID_DIR, { recursive: true })
  const fd = openSync(logPath, 'a')
  let child
  try {
    child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      detached: true,
      stdio: ['ignore', fd, fd],
    })
  } finally {
    closeSync(fd) // child has dup'd the fd; parent releases its copy
  }
  child.unref()
  return child
}

function readPids() {
  try {
    return JSON.parse(readFileSync(PIDS_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writePids(obj) {
  mkdirSync(PID_DIR, { recursive: true })
  writeFileSync(PIDS_FILE, JSON.stringify(obj, null, 2))
}

// ---- commands --------------------------------------------------------------

async function start() {
  const mock = hasMock()
  const config = mock ? MOCK_CONFIG : REAL_CONFIG

  if (existsSync(PIDS_FILE)) {
    const st = readPids()
    if (st && (alive(st.backend) || alive(st.web))) {
      console.error(
        `dev-bg already running (backend pid ${st.backend}). ` +
          `Use 'make dev-bg-stop' or 'dev-bg restart'.`,
      )
      process.exit(1)
    }
    // stale pid file (instance died) — drop it
    rmSync(PIDS_FILE, { force: true })
  }

  if (await portInUse(BACKEND_PORT)) {
    console.error(
      `port ${BACKEND_PORT} already in use — refuse to start (not killing strangers). ` +
        `Stop the other process (or 'make dev-bg-stop') first.`,
    )
    process.exit(1)
  }
  if (await portInUse(WEB_PORT)) {
    console.error(
      `port ${WEB_PORT} already in use — refuse to start. ` +
        `Stop the other process (or 'make dev-bg-stop') first.`,
    )
    process.exit(1)
  }

  console.log(`starting backend (${mock ? 'mock' : 'real model'}) on :${BACKEND_PORT} ...`)
  const backend = launch(
    join(PID_DIR, 'backend.log'),
    process.execPath,
    ['--import', 'tsx', 'packages/core/src/index.ts', '--config', config],
    ROOT,
    { FORCE_COLOR: '1' },
  )

  await waitBackend()

  console.log(`starting web on :${WEB_PORT} ...`)
  // Prefer vite's own bin from node_modules: `pnpm exec` is unreliable here —
  // the pnpm on PATH is a corepack shim that can hang (or get OOM-killed)
  // before it ever resolves, leaving the web dev server silently dead and
  // `dev-bg status` reporting "web: DEAD". Fall back to pnpm only when the
  // local vite bin is missing (e.g. before install).
  const viteBin = join(WEB, 'node_modules', 'vite', 'bin', 'vite.js')
  const web = existsSync(viteBin)
    ? launch(
        join(PID_DIR, 'web.log'),
        process.execPath,
        [viteBin, '--host', '127.0.0.1', '--port', String(WEB_PORT)],
        WEB,
        {},
      )
    : launch(
        join(PID_DIR, 'web.log'),
        'pnpm',
        ['exec', 'vite', '--host', '127.0.0.1', '--port', String(WEB_PORT)],
        WEB,
        {},
      )

  writePids({
    backend: backend.pid,
    web: web.pid,
    mock,
    startedAt: new Date().toISOString(),
  })

  console.log(
    `\nready: http://127.0.0.1:${WEB_PORT}  (backend :${BACKEND_PORT}, ` +
      `${mock ? 'mock' : 'real model'})`,
  )
  console.log(`logs: ${join(PID_DIR, 'backend.log')}, ${join(PID_DIR, 'web.log')}`)
  console.log('stop: make dev-bg-stop')
}

function stop(bestEffort = false) {
  if (!existsSync(PIDS_FILE)) {
    if (bestEffort) return
    console.error('no dev-bg instance recorded (nothing to stop).')
    process.exit(1)
  }
  const st = readPids()
  for (const key of ['backend', 'web']) {
    const pid = st?.[key]
    if (pid && alive(pid)) {
      // pid == pgid for detached children → negative pid kills the whole group.
      // Use 'SIGTERM' (not 'TERM' — this Node rejects the bare name).
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(PIDS_FILE, { force: true })
  console.log('stopped dev-bg (SIGTERM sent to process groups, pid file removed).')
}

function status() {
  if (!existsSync(PIDS_FILE)) {
    console.log('dev-bg: not running (no pid file at ' + PIDS_FILE + ').')
    return
  }
  const st = readPids()
  const bAlive = alive(st.backend)
  const wAlive = st.web ? alive(st.web) : false
  console.log(`dev-bg instance (started ${st.startedAt}, ` + `${st.mock ? 'mock' : 'real model'}):`)
  console.log(`  backend pid ${st.backend}: ${bAlive ? 'alive' : 'DEAD'}`)
  console.log(`  web     pid ${st.web}: ${wAlive ? 'alive' : 'DEAD'}`)
  // port liveness (independent of pid, in case of orphans)
  portInUse(BACKEND_PORT).then((b) =>
    portInUse(WEB_PORT).then((w) => {
      console.log(
        `  ports: :${BACKEND_PORT} ${b ? 'LISTENING' : 'free'}  ` +
          `:${WEB_PORT} ${w ? 'LISTENING' : 'free'}`,
      )
      if ((bAlive || b) && (wAlive || w)) {
        console.log('  → run "make dev-bg-stop" to tear down.')
      } else if (!bAlive && !wAlive && !b && !w) {
        console.log('  → stale pid file; safe to "make dev-bg start".')
      }
    }),
  )
}

async function restart() {
  if (existsSync(PIDS_FILE)) {
    const st = readPids()
    // preserve the running instance's --mock unless caller overrides
    if (!hasMock() && st?.mock) process.argv.push('--mock')
    stop(true)
    // give the old groups a moment to release the ports
    for (let i = 0; i < 10; i++) {
      if (!(await portInUse(BACKEND_PORT)) && !(await portInUse(WEB_PORT))) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  await start()
}

// ---- dispatch --------------------------------------------------------------

const cmd = process.argv[2]
switch (cmd) {
  case 'start':
    await start()
    break
  case 'stop':
    stop(false)
    break
  case 'status':
    status()
    break
  case 'restart':
    await restart()
    break
  default:
    console.error('usage: node scripts/dev-bg.mjs <start|stop|status|restart> [--mock]')
    process.exit(1)
}
