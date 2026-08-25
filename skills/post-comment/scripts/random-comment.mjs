#!/usr/bin/env node
/**
 * Random-comment helper for the post-comment skill.
 *
 * Two modes:
 *   --pick                              pick a random published post, print id/title/link
 *   --post <id> --content "<text>"      post a comment on that post
 *       [--name ".."] [--email ".."]    commenter identity (defaults below)
 *
 * Talks to the WordPress REST API of erishen.cn (override with ERISHEN_BASE).
 * Zero dependencies — uses Node's global fetch. No credentials are stored:
 * anonymous comment creation must be allowed by the site; if the API rejects
 * the request (e.g. Wordfence / rest_cannot_create) the raw error is printed
 * and the skill reports it instead of guessing.
 */

const BASE = process.env.ERISHEN_BASE ?? 'https://erishen.cn'
const WP = `${BASE}/wp-json/wp/v2`
const DEFAULT_NAME = '程序猿小林'
const DEFAULT_EMAIL = 'coder.xiaolin@163.com'

// Load <cwd>/.env into process.env (does not override already-set vars). This
// lets the skill pick up existing WordPress credentials without exporting them
// by hand. Safe: only reads, never prints secrets.
try {
  process.loadEnvFile()
} catch {
  // no .env in cwd — fine, rely on the ambient environment
}

// Optional auth for sites that require login to comment (comment_registration).
// Credentials come ONLY from the environment / .env — never hardcoded.
// Reuses the project's existing PROD_WORDPRESS_* variables (fall back to
// ERISHEN_WP_*), sent as HTTP Basic auth.
const wpUser = process.env.PROD_WORDPRESS_USERNAME ?? process.env.ERISHEN_WP_USER
const wpAppPassword = process.env.PROD_WORDPRESS_APP_PASSWORD ?? process.env.ERISHEN_WP_APP_PASSWORD
const authHeader =
  wpUser && wpAppPassword
    ? `Basic ${Buffer.from(`${wpUser}:${wpAppPassword}`).toString('base64')}`
    : undefined

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}
function has(name) {
  return process.argv.includes(name)
}
function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

async function pick() {
  // orderby=rand is disabled on this site (400), so fetch a batch and pick
  // locally — random enough for our purpose.
  const res = await fetch(`${WP}/posts?per_page=100&status=publish`)
  if (!res.ok) die(`list posts failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  const posts = await res.json()
  if (!Array.isArray(posts) || posts.length === 0) die('no published posts found')
  const p = posts[Math.floor(Math.random() * posts.length)]
  console.log(JSON.stringify({ id: p.id, title: (p.title?.rendered ?? '').trim(), link: p.link }))
}

async function post(postId, name, email, content) {
  if (!content) die('--content is required')
  // Anonymous commenters use author_name/author_email; `author` is a user ID
  // (integer) and gets rejected by the REST API when given a string.
  const res = await fetch(`${WP}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ post: postId, author_name: name, author_email: email, content }),
  })
  const text = await res.text()
  if (!res.ok) die(`post comment failed: ${res.status} ${text.slice(0, 300)}`)
  const c = JSON.parse(text)
  console.log(JSON.stringify({ id: c.id, status: c.status, post: c.post, link: c.link }))
}

if (has('--pick')) {
  await pick()
} else if (has('--post')) {
  const id = Number(arg('--post'))
  if (!Number.isInteger(id) || id <= 0) die('--post requires a numeric post id')
  await post(id, arg('--name') ?? DEFAULT_NAME, arg('--email') ?? DEFAULT_EMAIL, arg('--content'))
} else {
  die('usage: random-comment.mjs --pick | --post <id> --content "<text>" [--name ..] [--email ..]')
}
