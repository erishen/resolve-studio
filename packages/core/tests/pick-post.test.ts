import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickRandomPost } from '../src/plugins/tool-pick-post.js'

function fakeFetch(json: unknown, ok = true): typeof fetch {
  return (async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
  })) as unknown as typeof fetch
}

test('pickRandomPost returns a random post as JSON', async () => {
  const posts = [
    { id: 1, title: { rendered: 'Hello' }, link: 'http://x/1' },
    { id: 2, title: { rendered: 'World' }, link: 'http://x/2' },
  ]
  const out = await pickRandomPost(fakeFetch(posts))
  const parsed = JSON.parse(out) as { id: number; title: string; link: string }
  assert.ok([1, 2].includes(parsed.id))
  assert.ok(parsed.title.length > 0)
  assert.ok(parsed.link.length > 0)
})

test('pickRandomPost throws on a non-ok HTTP response', async () => {
  await assert.rejects(() => pickRandomPost(fakeFetch([], false)))
})

test('pickRandomPost throws when no posts are returned', async () => {
  await assert.rejects(() => pickRandomPost(fakeFetch([])))
})
