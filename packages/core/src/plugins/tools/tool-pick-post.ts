/**
 * `pick-post` tool — pick a random published post from erishen.cn (read-only).
 *
 * Read-only helper for the post-comment skill: it just does a GET against the
 * WordPress REST API and returns `{ id, title, link }`. Because it never
 * writes anything, it does NOT require approval — unlike the `--post` step
 * which stays behind the gated `shell` tool.
 *
 * This keeps the skill's read step frictionless: the model can call it as
 * often as it wants with zero prompts, and approval only appears for the
 * actual comment submission.
 */

import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

const BASE = process.env.ERISHEN_BASE ?? 'https://erishen.cn'
const TIMEOUT = 15_000

interface WpPost {
  id: number
  title?: { rendered?: string }
  link?: string
}

/**
 * Pure, injectable core of the `pick-post` tool. Picks a random published post
 * from the WordPress REST API. The `fetchImpl` argument is injected so tests
 * can drive it with a mock instead of hitting the network.
 */
export async function pickRandomPost(
  fetchImpl: typeof fetch = fetch,
  base: string = BASE,
): Promise<string> {
  const res = await fetchImpl(`${base}/wp-json/wp/v2/posts?per_page=100&status=publish`, {
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`list posts failed: ${res.status}`)
  const posts = (await res.json()) as WpPost[]
  if (!Array.isArray(posts) || posts.length === 0) throw new Error('no published posts found')
  const p = posts[Math.floor(Math.random() * posts.length)]
  return JSON.stringify({
    id: p.id,
    title: (p.title?.rendered ?? '').trim(),
    link: p.link ?? '',
  })
}

const registerPickPost = (ctx: Context) => {
  ctx.tools.register({
    name: 'pick-post',
    description:
      'Randomly pick one published post from erishen.cn (read-only, no approval). Returns JSON { id, title, link }. Use before commenting, or when the user wants a random blog post.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return pickRandomPost()
    },
  } satisfies Tool)
}

export const toolPickPost = definePlugin(registerPickPost, 'tool-pick-post', ['tools'])
