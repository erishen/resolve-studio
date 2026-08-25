import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

interface ComposerProps {
  value: string
  onChange: (text: string) => void
  onSend: (text: string) => void
  onPickFile?: () => void
  disabled?: boolean
}

export interface ComposerHandle {
  focus: () => void
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, onChange, onSend, onPickFile, disabled },
  ref,
) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Expose `focus()` so example chips can drop text in and focus the input.
  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
  }))

  // Grow the textarea with content, capped at a max height (then it scrolls).
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  // Keep height in sync when the value is set externally (e.g. an example pick).
  useEffect(() => {
    if (taRef.current) autoGrow(taRef.current)
  }, [value])

  const submit = () => {
    const v = value.trim()
    if (!v || disabled) return
    onSend(v)
    onChange('')
  }

  const canSend = !!value.trim() && !disabled

  return (
    <div className="composer">
      <div className="composer-box">
        <button
          type="button"
          className="composer-file"
          onClick={onPickFile}
          disabled={disabled}
          title="选择文件 / 目录"
          aria-label="选择文件"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={disabled ? 'Agent is thinking…' : 'Message the agent…'}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value)
            autoGrow(e.target)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button
          type="button"
          className="composer-send"
          onClick={submit}
          disabled={!canSend}
          title="Send (Enter)"
          aria-label="Send"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="20" x2="12" y2="4" />
            <polyline points="5 11 12 4 19 11" />
          </svg>
        </button>
      </div>
      <div className="composer-hint">
        <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
      </div>
    </div>
  )
})
