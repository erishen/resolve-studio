import { useEffect, useRef, useState } from 'react'
import { fetchDesktopLogins, startDesktopLogin } from '../api'

// reconnect=1: noVNC's WebSocket dies silently on backend recreate / network
// blips and then freezes on the last frame forever ("stuck on an old page").
// With reconnect it retries every 2s and the frame stays live.
const NOVNC_SRC =
  '/novnc/vnc.html?autoconnect=1&resize=scale&path=novnc/websockify&reconnect=1&reconnect_delay=2000&qualityLevel=9&compressionLevel=1'
const DEFAULT_WAIT_MS = 180_000

/**
 * Desktop view — embeds noVNC (served by the backend's websockify on :6080,
 * reverse-proxied by nginx at /novnc) so the user can watch and operate the
 * container's virtual display (:99) in real time. The "打开并登录" box launches
 * a headed Chrome on that display via the backend /api/desktop-login endpoint;
 * the user completes the interactive login (captcha / slider / 2FA) inside the
 * noVNC frame, and saved login domains are surfaced live.
 */
export function DesktopPanel() {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<'idle' | 'logging'>('idle')
  const [remaining, setRemaining] = useState(0)
  const [savedSites, setSavedSites] = useState<string[]>([])
  const [sfEnabled, setSfEnabled] = useState(false)
  const [sfLabel, setSfLabel] = useState('')
  const [sfUrl, setSfUrl] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    void fetchDesktopLogins().then((r) => {
      setSavedSites(r.sites ?? [])
      setSfEnabled(r.sfLoginEnabled ?? false)
      setSfLabel(r.sfLoginLabel ?? '')
      setSfUrl(r.sfLoginUrl ?? '')
    })
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const startLogin = async () => {
    const raw = url.trim()
    if (!raw) {
      setMessage('请输入要登录的网址')
      return
    }
    // 自动补全协议：无 scheme 时默认按 https:// 处理（example.com → https://example.com），
    // 少一个报错分支，输入框随手贴域名就能用。
    const target = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    setStatus('logging')
    setRemaining(Math.round(DEFAULT_WAIT_MS / 1000))
    setMessage(null)
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setRemaining((s) => (s > 0 ? s - 1 : 0))
    }, 1000)

    try {
      const result = await startDesktopLogin(target, DEFAULT_WAIT_MS)
      if (result.ok) {
        setSavedSites(result.sites ?? [])
        setMessage(
          result.sites && result.sites.length
            ? `已收集 Cookie 的站点：${result.sites.join('、')}（访问即有 Cookie，不代表登录；Cookie 已持久化供下次复用）`
            : '窗口已关闭，但未检测到登录态 Cookie，请确认是否完成登录',
        )
      } else {
        setMessage(result.message ?? '登录启动失败')
      }
    } catch {
      setMessage('请求后端失败，请确认桌面服务（websockify :6080）已在运行')
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setStatus('idle')
      setRemaining(0)
    }
  }

  const startSfLogin = async () => {
    if (!sfUrl) return
    setStatus('logging')
    setRemaining(Math.round(DEFAULT_WAIT_MS / 1000))
    setMessage(
      `Chrome 已在下方桌面打开 ${sfUrl}，请在画面里完成登录；检测到登录态后自动继续并写回会话`,
    )
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setRemaining((s) => (s > 0 ? s - 1 : 0))
    }, 1000)
    try {
      const result = await startDesktopLogin(sfUrl, DEFAULT_WAIT_MS, {
        exportSfState: true,
      })
      if (result.ok) {
        setSavedSites(result.sites ?? [])
        setMessage(
          result.stateExported
            ? '登录态已保存并写回会话文件，可直接触发对应的发布任务'
            : '窗口已关闭，但未检测到登录态 Cookie，请确认是否完成登录',
        )
      } else {
        setMessage(result.message ?? '登录启动失败')
      }
    } catch {
      setMessage('请求后端失败，请确认桌面服务（websockify :6080）已在运行')
    } finally {
      if (timerRef.current) clearInterval(timerRef.current)
      setStatus('idle')
      setRemaining(0)
    }
  }

  return (
    <div className="desktop-view">
      <div className="desktop-bar">
        <input
          className="desktop-url"
          type="text"
          placeholder="https://example.com/login"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={status === 'logging'}
        />
        <button
          className="btn btn-primary"
          onClick={() => void startLogin()}
          disabled={status === 'logging'}
        >
          {status === 'logging' ? `登录中… (${remaining}s)` : '打开并登录'}
        </button>
        {sfEnabled && sfUrl && (
          <button
            className="btn"
            onClick={() => void startSfLogin()}
            disabled={status === 'logging'}
            title={`在 VNC 桌面里打开 ${sfUrl}，登录后自动写回会话文件，供对应发布任务复用（SF_LOGIN_ENABLED=1 且配置 SF_LOGIN_URL 时显示）`}
          >
            {sfLabel || '登录'}
          </button>
        )}
        <button
          className="btn"
          onClick={() => void frameRef.current?.requestFullscreen?.().catch(() => {})}
          title="把 VNC 桌面放大到整个屏幕（Esc 退出）"
        >
          全屏
        </button>
        <span className="desktop-hint">
          点「打开并登录」→ 在下方桌面里完成登录（滑块/2FA）→ 窗口自动关闭即保存
        </span>
      </div>

      {message && <div className="desktop-msg">{message}</div>}

      {savedSites.length > 0 && (
        <div className="desktop-saved">
          Cookie 站点（访问即留下；真实登录态以写回会话文件为准）：
          {savedSites.map((s) => (
            <span className="tool-chip" key={s}>
              {s}
            </span>
          ))}
        </div>
      )}

      <iframe
        className="desktop-frame"
        ref={frameRef}
        src={NOVNC_SRC}
        title="容器桌面 (noVNC)"
        allow="fullscreen"
      />
    </div>
  )
}
