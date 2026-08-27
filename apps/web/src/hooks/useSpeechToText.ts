import { useCallback, useRef, useState } from 'react'

// TypeScript doesn't ship SpeechRecognition types by default (it's a
// webkit-prefixed API in most browsers). Declare the minimal shape we need.
interface SpeechRecognitionResult {
  transcript: string
}
interface SpeechRecognitionEvent {
  results: ArrayLike<ArrayLike<SpeechRecognitionResult>>
  resultIndex: number
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface UseSpeechToTextOptions {
  /** BCP-47 language tag, e.g. 'zh-CN' or 'en-US'. Defaults to zh-CN. */
  lang?: string
}

/**
 * Speech-to-text hook backed by the browser's Web Speech API.
 *
 * Returns `{ listening, supported, toggle, transcript }`. Call `toggle()` to
 * start/stop; recognized text is appended to `transcript` in real time (interim
 * results are included so the user sees partial text while speaking).
 */
export function useSpeechToText({ lang = 'zh-CN' }: UseSpeechToTextOptions = {}) {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const finalRef = useRef('')

  const supported = getRecognitionCtor() !== null

  const stop = useCallback(() => {
    recognitionRef.current?.stop()
    setListening(false)
  }, [])

  const start = useCallback(() => {
    const Ctor = getRecognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    finalRef.current = ''
    setTranscript('')

    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const text = result[0]?.transcript ?? ''
        // result.isFinal isn't in our minimal type, but the 2nd tuple element
        // of each result is the isFinal boolean in the real API.
        const isFinal = (result as unknown as { isFinal?: boolean }).isFinal
        if (isFinal) finalRef.current += text
        else interim += text
      }
      setTranscript(finalRef.current + interim)
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)

    recognitionRef.current = rec
    rec.start()
    setListening(true)
  }, [lang])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  return { listening, supported, toggle, transcript, setTranscript, stop }
}
