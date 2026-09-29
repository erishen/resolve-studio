/**
 * Desktop VNC "headed login" helper.
 *
 * Opens a *headed* Chrome (playwright-core, channel: 'chrome') on the container's
 * virtual display (DISPLAY :99, provided by Xvfb in the entrypoint) inside a
 * persistent user-data dir, navigates to the target site, and waits `waitMs`
 * while the user completes an interactive login (captcha / slider / 2FA) in the
 * noVNC desktop view. When the window closes, cookies persist to the profile dir
 * and the list of covered domains is returned + cached so the UI can show the
 * saved login state on reload.
 *
 * Only one headed session runs at a time (the virtual display is shared), so a
 * module-level lock serializes calls — a second concurrent request gets 409.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext } from 'playwright-core'

const PROFILE_DIR = join(process.cwd(), '.data', 'browser_profile')
const LOGINS_CACHE = join(PROFILE_DIR, 'logins.json')

let active: Promise<DesktopLoginResult> | null = null

export interface DesktopLoginResult {
  ok: boolean
  /** Domains that have at least one (non-localhost) cookie after the session. */
  sites: string[]
  /** Human-readable note (e.g. conflict / invalid URL). */
  message?: string
  /** ISO timestamp the login state was last written. */
  updatedAt?: string
}

function cacheLogins(sites: string[]): void {
  try {
    mkdirSync(PROFILE_DIR, { recursive: true })
    const payload = { updatedAt: new Date().toISOString(), sites }
    writeFileSync(LOGINS_CACHE, JSON.stringify(payload), 'utf8')
  } catch {
    /* best-effort cache; ignore write errors */
  }
}

/** Read the cached login-state summary (domains with saved cookies). */
export function readCachedLogins(): DesktopLoginResult {
  try {
    const raw = readFileSync(LOGINS_CACHE, 'utf8')
    const parsed = JSON.parse(raw) as { updatedAt: string; sites: string[] }
    return { ok: true, sites: parsed.sites ?? [], updatedAt: parsed.updatedAt }
  } catch {
    return { ok: true, sites: [] }
  }
}

/**
 * Open a headed Chrome on the virtual display and wait for the user to finish
 * logging in. Resolves once `waitMs` elapses (or the caller aborts by calling
 * again — the lock prevents overlap).
 */
export async function runDesktopLogin(url: string, waitMs = 180_000): Promise<DesktopLoginResult> {
  if (active) {
    return { ok: false, sites: [], message: '另一个桌面登录会话正在进行中，请稍后再试' }
  }

  mkdirSync(PROFILE_DIR, { recursive: true })

  const run = (async (): Promise<DesktopLoginResult> => {
    const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      // Inherit the backend's env so DISPLAY (:99) reaches the browser process;
      // fall back to :99 if somehow unset.
      env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':99' },
      viewport: { width: 1600, height: 900 },
    })
    try {
      const page = await context.newPage()
      // goto failure (bad URL / interstitial) must not abort the wait — the user
      // may still be mid-redirect. Just open and keep the window alive.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      const cookies = await context.cookies()
      const sites = [
        ...new Set(
          cookies
            .map((c) => c.domain)
            .filter((d) => d && d !== 'localhost' && !d.startsWith('localhost:')),
        ),
      ]
      cacheLogins(sites)
      return { ok: true, sites, updatedAt: new Date().toISOString() }
    } finally {
      await context.close().catch(() => {})
    }
  })()

  // Clear the lock whether the run resolved or threw.
  active = run.finally(() => {
    active = null
  })
  return active
}
