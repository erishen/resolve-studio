/**
 * `browser` tools — read-only web exploration via Playwright.
 *
 * Two tools give the agent the ability to *look at* the web:
 *   - `browser-open`:       open a URL, return the page title + readable text
 *   - `browser-screenshot`: open a URL, save a screenshot PNG, return its path
 *
 * Read-only by design (the user chose "只读探索"): no clicks, no form filling,
 * no approval gate — opening a page and reading it is harmless. The browser is
 * the shared browser-desk container (Chrome, CDP at $CDP_URL), connected once
 * via `connectOverCDP` and reused across calls — no browser ships inside this
 * image anymore.
 *
 * Guards:
 *  - http(s) URLs only;
 *  - 12s navigation timeout;
 *  - text output capped at 8 KiB;
 *  - screenshots land under `<cwd>/.data/screenshots/` (gitignored).
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { chromium } from 'playwright-core'
import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const NAV_TIMEOUT = 12_000
const MAX_TEXT = 8 * 1024
const SHOT_DIR = join(process.cwd(), '.data', 'screenshots')
// 共享浏览器（browser-desk 容器）的 CDP 端点；compose 注入 http://browser-desk:9222。
// 容器内默认回环，便于宿主 make dev 直连本机 Chrome 调试。
const CDP_URL = process.env['CDP_URL'] ?? 'http://127.0.0.1:9222'
// browser-desk 的 Chrome 启动需要几秒（Xvfb→VNC→Chrome 串行），连接失败重试而不是直接抛。
const CDP_CONNECT_RETRIES = 5
const CDP_CONNECT_RETRY_DELAY_MS = 1000

function assertHttpUrl(raw: unknown): string {
  const url = String(raw ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are supported')
  return url
}

const registerBrowser = (ctx: Context) => {
  let browser: Browser | null = null

  const getBrowser = async (): Promise<Browser> => {
    if (browser && browser.isConnected()) return browser
    ctx.logger('browser').info(`connecting to shared browser-desk via CDP (${CDP_URL})…`)
    let lastErr: unknown
    for (let i = 0; i < CDP_CONNECT_RETRIES; i++) {
      try {
        browser = await chromium.connectOverCDP(CDP_URL)
        return browser
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, CDP_CONNECT_RETRY_DELAY_MS))
      }
    }
    throw new Error(
      `无法连接共享浏览器 browser-desk（${CDP_URL}）：请确认 browser-desk 容器已启动` +
        (lastErr instanceof Error ? `（${lastErr.message}）` : ''),
    )
  }

  const openPage = async (rawUrl: string): Promise<Page> => {
    const url = assertHttpUrl(rawUrl)
    const b = await getBrowser()
    const page = await b.newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
      return page
    } catch (err) {
      await page.close().catch(() => {})
      throw err
    }
  }

  ctx.tools.register({
    name: 'browser-open',
    description:
      'Open a URL in a headless browser and return the page title plus readable text content (max 8 KiB). Use for read-only web research.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to visit.' },
      },
      required: ['url'],
    },
    async execute(args) {
      const page = await openPage(String(args['url'] ?? ''))
      try {
        const title = await page.title()
        // locator API avoids needing a DOM lib in the Node-side tsconfig.
        const body = await page
          .locator('body')
          .innerText()
          .catch(() => '')
        const text = body.trim()
        return text.length > MAX_TEXT
          ? `title: ${title}\n\n${text.slice(0, MAX_TEXT)}\n… [truncated at ${MAX_TEXT} chars]`
          : `title: ${title}\n\n${text}`
      } finally {
        await page.close().catch(() => {})
      }
    },
  } satisfies Tool)

  ctx.tools.register({
    name: 'browser-screenshot',
    description:
      'Open a URL in a headless browser, save a full-page screenshot PNG under .data/screenshots/, and return the absolute file path. Use to visually inspect a page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to visit.' },
      },
      required: ['url'],
    },
    async execute(args) {
      const page = await openPage(String(args['url'] ?? ''))
      try {
        mkdirSync(SHOT_DIR, { recursive: true })
        const file = join(SHOT_DIR, `${Date.now()}.png`)
        await page.screenshot({ path: file, fullPage: false })
        return `screenshot saved to ${file}`
      } finally {
        await page.close().catch(() => {})
      }
    },
  } satisfies Tool)

  // Cordis disposer: CDP 连接随进程退出自动释放，不能调用 browser.close()
  // （connectOverCDP 的 close 会关闭远端 Chrome —— 那正是 browser-desk 共享的那个）。
  // 仅置空引用，下次 getBrowser 重新连接。
  return () => {
    browser = null
  }
}

export const toolBrowser = definePlugin(registerBrowser, 'tool-browser', ['tools'])
