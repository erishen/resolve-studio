/**
 * Best-effort secret redaction for streamed tool progress.
 *
 * Long-running tools (pse-review, publishers, ...) pipe child-process
 * stdout/stderr straight into the tool card's live panel via `onProgress`.
 * A script that accidentally debug-prints a credential would then show it on
 * screen. This sanitizer runs on every progress chunk at the single
 * `ToolRegistry.call` boundary, so no tool needs to redact on its own.
 *
 * It is a defensive net, not a guarantee: it targets the common leakage shapes
 * (Bearer headers, `key=value` env/query/log pairs, bare `sk-…` keys, Cookie
 * headers) and keeps the key name so the panel still shows *which* field was
 * hidden. Normal prose that merely mentions a word like "token" without an
 * `=`/`:` separator is left untouched.
 */

type Rule = [RegExp, string]

// Order matters: Bearer / Cookie whole-header forms run before the generic
// key=value pass so they are not partially rewritten.
const RULES: Rule[] = [
  // Cookie / Set-Cookie headers — the whole value is a session blob.
  [/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  // Authorization header, any scheme (Bearer / Basic / Digest) — swallow the
  // whole line first so the dedicated Bearer pass below only catches a bare
  // "Bearer <token>" that appears without an Authorization header.
  [/\bAuthorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]'],
  // Bare "Bearer <token>" not preceded by an Authorization header.
  [/(?<!Authorization\s*:\s)\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  // Bare OpenAI-style keys: sk-..., sk-proj-..., sk-ant-...
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]'],
  // key=value / key: value pairs in env dumps, URL query strings, logs, headers.
  // The leading boundary is `(^|[^A-Za-z0-9])` rather than `\b` so SCREAMING_SNAKE
  // env vars like OPENAI_API_KEY= / APP_SECRET= match (the underscore before the
  // key is a word char, where `\b` would not fire). Only fires next to an `=` or
  // `:` separator, so the plain word "token" in prose is never masked.
  [
    /(^|[^A-Za-z0-9])(api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret|app[_-]?secret|appsecret|secret|token|password|passwd|pwd|credential|auth)\s*[=:]\s*"?[^\s&;,'"]+"?/gi,
    '$1$2=[REDACTED]',
  ],
]

/**
 * Redact common credential shapes from a progress chunk. Returns the original
 * string unchanged when no rule matches (cheap fast path).
 */
export function redactSecrets(chunk: string): string {
  if (!chunk) return chunk
  let out = chunk
  for (const [re, repl] of RULES) {
    out = out.replace(re, repl)
  }
  return out
}
