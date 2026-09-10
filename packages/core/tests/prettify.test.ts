import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkifyArtifactHtml, tidyToolEcho, prettifyAnswer, isSkipNotice } from '../src/plugins/web-server.js'

const BASE = 'http://127.0.0.1:8787'
const ROOTS = ['/Users/erishen/Workspace/CNB/individular-invest']

test('linkifyArtifactHtml turns an in-sandbox .html path into a /api/raw link', () => {
  const text =
    '📊 总览已生成: /Users/erishen/Workspace/CNB/individular-invest/frameworks/llamaindex-pse/tasks/hot-news/hot-news-overview.html'
  const out = linkifyArtifactHtml(text, BASE, ROOTS)
  assert.match(out, /\[hot-news-overview\.html\]\(http:\/\/127\.0\.0\.1:8787\/api\/raw\?path=/)
  assert.ok(out.includes('hot-news-overview.html'), 'filename label preserved')
  // the raw absolute path must NOT appear in clear text anymore
  assert.ok(!out.includes('/Users/erishen/Workspace'), 'long fs path hidden behind the link')
})

test('linkifyArtifactHtml leaves out-of-sandbox paths untouched (no dead link)', () => {
  const text = 'report at /tmp/secret/report.html'
  const out = linkifyArtifactHtml(text, BASE, ROOTS)
  assert.equal(out, text)
})

test('tidyToolEcho collapses → /abs/path directory echoes to the trailing name', () => {
  const text =
    'hot-news-fetch 完成 → /Users/erishen/Workspace/CNB/individular-invest/frameworks/llamaindex-pse/tasks/hot-news/news（全部源）'
  const out = tidyToolEcho(text)
  assert.equal(
    out,
    'hot-news-fetch 完成 → news（全部源）',
    'the long path is shortened to its basename, label preserved',
  )
})

test('prettifyAnswer cleans the real hot-news success bubble', () => {
  const raw = [
    'hot-news-fetch 完成 → /Users/erishen/Workspace/CNB/individular-invest/frameworks/llamaindex-pse/tasks/hot-news/news（全部源）',
    '▶ 抓取热点新闻 → /Users/erishen/Workspace/CNB/individular-invest/frameworks/llamaindex-pse/tasks/hot-news/news（直连）',
    '✅ 完成：新增/更新 98 条，清理旧文件 88 个 → /Users/erishen/Workspace/CNB/individular-invest/frameworks/llamaindex-pse/tasks/hot-news/news',
    '📊 总览已生成: /Users/erishen/Workspace/CNB/individular-invest/frameworks/llamaindex-pse/tasks/hot-news/hot-news-overview.html',
  ].join('\n')
  const out = prettifyAnswer(raw, BASE, ROOTS)
  // directory echoes collapsed
  assert.ok(out.includes('→ news（全部源）'), 'full-source echo shortened')
  assert.ok(out.includes('→ news（直连）'), 'direct echo shortened')
  assert.ok(out.includes('→ news'), 'cleanup echo shortened')
  // overview is now a clickable preview link, long path gone
  assert.match(out, /📊 总览已生成: \[hot-news-overview\.html\]\(http:\/\/127\.0\.0\.1:8787\/api\/raw\?path=/)
  assert.ok(!out.includes('/Users/erishen/Workspace/CNB/individular-invest/frameworks'), 'no long path leaks')
})

test('isSkipNotice recognises duplicate-call placeholders but not real output', () => {
  const skip =
    '(skipped: "hot-news-topics" was already called in this same round with identical arguments "{}" — its result above is reused)'
  assert.equal(isSkipNotice(skip), true)
  assert.equal(isSkipNotice(`  ${skip}`), true, 'leading whitespace tolerated')
  assert.equal(isSkipNotice('✅ 完成：新增/更新 98 条'), false, 'real conclusions are not skips')
  assert.equal(isSkipNotice(''), false)
  assert.equal(isSkipNotice(undefined), false)
})
