import { useEffect, useRef, useState } from 'react'
import { fetchDesktopLogins, startDesktopLogin } from '../api'

const NOVNC_SRC = '/novnc/vnc.html?autoconnect=1&resize=scale&path=novnc/websockify'
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
  const [message, setMessage] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    void fetchDesktopLogins().then((r) => setSavedSites(r.sites ?? []))
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const startLogin = async () => {
    const target = url.trim()
    if (!/^https?:\/\//i.test(target)) {
      setMessage('请输入以 http(s):// 开头的网址')
      return
    }
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
            ? `登录态已保存：${result.sites.join('、')}（下次有头/无头复用）`
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
        <span className="desktop-hint">
          点「打开并登录」→ 在下方桌面里完成登录（滑块/2FA）→ 窗口自动关闭即保存
        </span>
      </div>

      {message && <div className="desktop-msg">{message}</div>}

      {savedSites.length > 0 && (
        <div className="desktop-saved">
          已保存登录态：
          {savedSites.map((s) => (
            <span className="tool-chip" key={s}>
              {s}
            </span>
          ))}
        </div>
      )}

      <iframe
        className="desktop-frame"
        src={NOVNC_SRC}
        title="容器桌面 (noVNC)"
        allow="fullscreen"
      />
    </div>
  )
}
