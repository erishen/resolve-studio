/**
 * Helpers for the backend artifact-preview URL convention.
 *
 * The backend turns an absolute artifact path (e.g. a generated
 * `hot-news-overview.html`) into a servable link:
 *
 *   http://127.0.0.1:8787/api/raw?path=%2FUsers%2F...%2Fhot-news-overview.html
 *
 * The whole filesystem path is a single percent-encoded query value, so the
 * URL has NO path segments for the file — anything that derives a name from
 * the URL must decode `path` first. A naive `url.split('/').pop()` yields
 * `raw?path=%2FUsers%2F...` instead of the file name, which is exactly the
 * `raw?path=…` label bug this module fixes.
 */

/** Decoded filesystem path behind an `/api/raw?path=` artifact URL, or null. */
export function artifactPath(url: string): string | null {
  const m = url.match(/[?&]path=([^&]+)/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    // Malformed percent-encoding — caller falls back to the raw string.
    return null
  }
}

/** Short, human-readable label for a preview target (button text + modal title). */
export function previewLabel(p: string): string {
  const source = artifactPath(p) ?? p
  return source.split(/[/\\]/).filter(Boolean).pop() ?? source
}

/**
 * True when a preview target should be rendered in an iframe.
 *
 * Covers both:
 *  - a plain http(s) URL whose path ends in .html/.htm, and
 *  - a backend artifact URL (`/api/raw?path=<abs>.html`) whose *decoded* path
 *    ends in .html — its URL pathname is always `/api/raw`, so the old
 *    `new URL(p).pathname` check silently failed and the modal rendered an
 *    empty body.
 */
export function isIframePreview(p: string): boolean {
  if (!/^https?:\/\//i.test(p)) return false
  const decoded = artifactPath(p)
  if (decoded) return /\.html?$/i.test(decoded)
  try {
    return /\.html?$/i.test(new URL(p).pathname)
  } catch {
    return false
  }
}
