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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'

const PROFILE_DIR = join(process.cwd(), '.data', 'browser_profile')
const LOGINS_CACHE = join(PROFILE_DIR, 'logins.json')

let active: Promise<DesktopLoginResult> | null = null
let activeStartedAt = 0
// Generation token: a stale run's finally must not clear a NEWER lock taken
// after a deadlock override (see LOCK_STALE_MS below).
let activeGen = 0
// Deadlock guard: a run can in principle outlive its waitMs (e.g. a wedged
// launchPersistentContext holding the profile's SingletonLock). After this
// long, treat the lock as stale and let a new session through.
const LOCK_STALE_MS = 15 * 60_000

export interface DesktopLoginResult {
  ok: boolean
  /** Domains that have at least one (non-localhost) cookie after the session. */
  sites: string[]
  /** Human-readable note (e.g. conflict / invalid URL). */
  message?: string
  /** ISO timestamp the login state was last written. */
  updatedAt?: string
  /** True when the session state was also exported to a storageState file. */
  stateExported?: boolean
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
export async function runDesktopLogin(
  url: string,
  waitMs = 180_000,
  exportStatePath?: string,
): Promise<DesktopLoginResult> {
  if (active && Date.now() - activeStartedAt < LOCK_STALE_MS) {
    return {
      ok: false,
      sites: [],
      message:
        '另一个桌面登录会话正在进行中，请稍后再试（关闭 VNC 里的浏览器窗口即可立即结束上一会话）',
    }
  }

  mkdirSync(PROFILE_DIR, { recursive: true })

  // Wipe Chrome's session-restore data BEFORE launch. The persistent profile
  // otherwise resurrects the previous session's tabs over our target page
  // (e.g. a stale localhost:18080 page filling the whole VNC screen) — and the
  // restore happens asynchronously AFTER launch, so closing stray pages post
  // launch races Chrome and loses. Deleting the session files is safe: only
  // "reopen last tabs" is lost, cookies / logins / localStorage stay.
  try {
    rmSync(join(PROFILE_DIR, 'Default', 'Sessions'), { recursive: true, force: true })
    const prefsPath = join(PROFILE_DIR, 'Default', 'Preferences')
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as {
      profile?: Record<string, unknown>
      session?: Record<string, unknown>
    }
    prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true }
    // restore_on_startup: 5 = open the New Tab page (never restore last session)
    prefs.session = { ...prefs.session, restore_on_startup: 5 }
    writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8')
  } catch {
    /* first launch (no profile yet) or best-effort cleanup — both fine */
  }

  const gen = ++activeGen
  activeStartedAt = Date.now()
  const run = (async (): Promise<DesktopLoginResult> => {
    const context: BrowserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: 'chrome',
      // hide-crash-restore-bubble: the container may kill Chrome mid-session
      // (restart/stop), so the profile's exit_type can be "Crashed" — without
      // this flag Chrome pops a "Restore pages?" bubble on the next launch.
      // disable-blink-features=AutomationControlled + dropping the default
      // --enable-automation keep navigator.webdriver falsy — Geetest-style
      // sliders (site login) reject the drag otherwise even when dragged right.
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-crash-restore-bubble',
        '--disable-blink-features=AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      // Inherit the backend's env so DISPLAY (:99) reaches the browser process;
      // fall back to :99 if somehow unset.
      env: { ...process.env, DISPLAY: process.env['DISPLAY'] ?? ':99' },
      viewport: { width: 1280, height: 800 },
    })
    try {
      // Belt & braces for risk-control checks: make navigator.webdriver report
      // "not automated" in every page (probe tabs included) from the start.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      })
      const page = await context.newPage()
      // The persistent profile restores the previous session's tabs on launch
      // (e.g. whatever URL was last opened via the login box) — the desktop
      // would otherwise "default" to showing stale pages. Close anything that
      // is not our target page, and keep closing stragglers Chrome restores
      // asynchronously right after launch.
      // Probe pages registered in `aux` are part of the login verification
      // (opened/closed by sfLoginVerified below) and must be exempt from the
      // stray-tab reaper. Declared before any await so the 'page' handler
      // can never touch it in its temporal dead zone.
      const aux = new Set<Page>()
      const closeStray = (p: Page): void => {
        if (p !== page && !aux.has(p)) void p.close().catch(() => {})
      }
      context.pages().forEach(closeStray)
      context.on('page', closeStray)
      // goto failure (bad URL / interstitial) must not abort the wait — the user
      // may still be mid-redirect. Just open and keep the window alive.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
      // Auto-fill the login phone (optional SF_LOGIN_PHONE from .env) so the
      // user only has to type the SMS code. Best-effort: guests get redirected
      // to the login page where the form lives; if already logged in or the
      // phone is not configured, skip silently.
      if (exportStatePath && process.env['SF_LOGIN_PHONE']) {
        const phone = process.env['SF_LOGIN_PHONE']
        await page
          .waitForSelector('input[name="mobile"], input[placeholder="手机号"]', { timeout: 15_000 })
          .then((el) => (el ? el.fill(phone).catch(() => {}) : null))
          .catch(() => {})
      }
      // Poll for completion instead of dead-waiting the full waitMs (the old
      // behavior kept a pointless countdown running long after the user had
      // finished logging in). End the session early when:
      //   - login is verified (see below), or
      //   - every browser window is closed (user is done), or
      //   - the deadline (waitMs) is reached (upper bound for hard cases).
      // NOTE: for the export flow, cookie presence is NOT login evidence —
      // the target site hands a session cookie (PHPSESSID) to guests too
      // (verified 2026-09-29: a guest PHPSESSID still gets 307'd from the
      // write page to the login page). Login is therefore verified
      // BEHAVIORALLY: the write page must not bounce to the login page.
      // Generic (non-export) flow keeps the domain-cookie check.
      const targetHost = (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, '')
        } catch {
          return null // unparseable URL → fall back to deadline-only wait
        }
      })()
      const hasDomainCookie = (cookies: { domain?: string }[]): boolean => {
        if (!targetHost) return false
        return cookies.some((c) => {
          const host = (c.domain || '').replace(/^\./, '')
          return (
            host === targetHost ||
            host.endsWith(`.${targetHost}`) ||
            targetHost.endsWith(`.${host}`)
          )
        })
      }
      // Behavioral verification for the export flow: open a throwaway probe
      // tab on the target's write page and confirm it stays there (guests get
      // bounced to the login page). Probe pages are exempted from closeStray
      // via `aux`.
      const sfLoginVerified = async (): Promise<boolean> => {
        if (!targetHost) return false
        let probe: Page | null = null
        try {
          probe = await context.newPage()
          aux.add(probe)
          await probe.goto(`https://${targetHost}/write`, {
            waitUntil: 'domcontentloaded',
            timeout: 20_000,
          })
          return !/\/user\/login/.test(probe.url())
        } catch {
          return false
        } finally {
          if (probe) {
            aux.delete(probe)
            await probe.close().catch(() => {})
          }
        }
      }
      const deadline = Date.now() + waitMs
      let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = []
      let sfLoggedIn = false
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000))
        try {
          if (context.pages().length === 0) break // all windows closed
          cookies = await context.cookies()
          if (exportStatePath) {
            // Focus-safe success signal: guests land on the login page (with
            // ?next=/write) and the same tab navigates back to the write page
            // after a successful login. Watch page URLs instead of probing — a
            // probe tab opened every few seconds would steal focus from the
            // slider / SMS code mid-entry and break the interaction.
            const writeRe = targetHost && new RegExp(`${targetHost.replace(/\./g, '\\.')}\\/write`)
            const backOnWrite =
              !!writeRe &&
              context.pages().some((p) => writeRe.test(p.url()) && !/user\/login/.test(p.url()))
            if (backOnWrite) {
              // One-time behavioral confirmation (single brief probe tab).
              sfLoggedIn = await sfLoginVerified()
              if (sfLoggedIn) break // logged in (verified)
            }
          } else if (hasDomainCookie(cookies)) {
            break // generic flow: domain cookie is the best available signal
          }
        } catch {
          break // context already closed
        }
      }
      // Refresh cookies if the loop ended without a successful read (window
      // closed / context gone can leave the last read stale or empty).
      if (!cookies.length) {
        try {
          cookies = await context.cookies()
        } catch {
          /* context already closed */
        }
      }
      // 收尾兜底验证：用户可能在「非写文页」完成登录（如扫码落在引导页），实时
      // URL 监视只认写文页，会漏掉这种「已登录但不在写文页」的情况，导致会话被
      // 静默丢弃、下次发布仍报游客态。到这里若还没确认登录、但档案里有目标站
      // cookie，就开一个一次性探针 tab 到写文页做行为级复核——登录即写回，避免
      // 白登录。（上下文已关闭则探针会抛错，catch 后放弃兜底。）
      if (exportStatePath && !sfLoggedIn) {
        try {
          sfLoggedIn = await sfLoginVerified()
        } catch {
          /* context 已关闭则放弃兜底 */
        }
      }
      const sites = [
        ...new Set(
          cookies
            .map((c) => c.domain)
            .filter((d) => d && d !== 'localhost' && !d.startsWith('localhost:')),
        ),
      ]
      // Export flow: exporting a guest session is worse than useless — it makes
      // the publish script believe it has a login. Only export when the
      // behavioral probe verified the write page stays put (no bounce to the
      // login page).
      if (exportStatePath && !sfLoggedIn) {
        return {
          ok: false,
          sites,
          message:
            '未检测到真实登录态（写文页仍被重定向到登录页——现有会话 cookie 只是游客会话）——请在下方桌面画面里完成账号登录后重试；已跳过写回，避免用游客会话覆盖',
          updatedAt: new Date().toISOString(),
        }
      }
      cacheLogins(sites)
      let stateExported = false
      if (exportStatePath) {
        try {
          // 把当前上下文的 storageState（cookies + localStorage）导出成纯 JSON，
          // 供发布脚本的 getContext 复用登录态。
          // 容器内 Linux Chrome 持久化档案 → 纯 JSON 传递，绕开 macOS 钥匙串跨 OS 加密问题。
          await context.storageState({ path: exportStatePath })
          stateExported = true
        } catch {
          /* storageState export is best-effort; ignore write errors */
        }
      }
      return { ok: true, sites, updatedAt: new Date().toISOString(), stateExported }
    } finally {
      await context.close().catch(() => {})
    }
  })()

  // Clear the lock whether the run resolved or threw — but only if this run is
  // still the current generation (a deadlock override may have started a newer
  // one; the stale run's finally must not clear that newer lock).
  active = run.finally(() => {
    if (gen === activeGen) {
      active = null
    }
  })
  return active
}
