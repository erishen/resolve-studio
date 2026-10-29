import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeToolName, ToolNameMap } from '../src/util/llm-tool-name.js'

// Regression: OpenAI-compatible providers reject internal MCP tool names
// (`fs:read_file` — colon not in ^[a-zA-Z0-9_-]+$) with
// "400 invalid tool/function name ... Invalid 'tools[10].function.name'",
// which broke every task whose whitelist contains the `fs` prefix.
test('sanitizeToolName re-spells MCP namespace separators to a provider-safe form', () => {
  assert.equal(sanitizeToolName('fs:read_file'), 'fs__read_file')
  assert.equal(sanitizeToolName('git:git_status'), 'git__git_status')
  assert.equal(sanitizeToolName('pse-review:pse-review'), 'pse-review__pse-review')
  // already-safe names pass through unchanged
  assert.equal(sanitizeToolName('read-file'), 'read-file')
  assert.equal(sanitizeToolName('pse-review-latest'), 'pse-review-latest')
  // every sanitized spelling satisfies the provider pattern
  for (const n of ['fs:read_file', 'a.b', 'a b', 'x:y:z', 'weird!@#', '工具:名']) {
    assert.match(sanitizeToolName(n), /^[a-zA-Z0-9_-]+$/, n)
  }
})

test('ToolNameMap round-trips internal ↔ provider names', () => {
  const names = [
    'read-file',
    'write-file',
    'shell',
    'skill-run',
    'fs:read_file',
    'fs:list_directory',
    'pse-review',
    'pse-review-latest',
    'pse-review:pse-review',
  ]
  const map = new ToolNameMap(names)
  for (const n of names) {
    assert.match(map.toLlm(n), /^[a-zA-Z0-9_-]+$/, n)
    assert.equal(map.toInternal(map.toLlm(n)), n)
  }
})

test('ToolNameMap disambiguates sanitization collisions', () => {
  // 'a:b' and 'a__b' both sanitize to 'a__b' — the map must stay injective
  const map = new ToolNameMap(['a:b', 'a__b'])
  assert.notEqual(map.toLlm('a:b'), map.toLlm('a__b'))
  assert.equal(map.toInternal(map.toLlm('a:b')), 'a:b')
  assert.equal(map.toInternal(map.toLlm('a__b')), 'a__b')
})

test('unknown names: sanitize outbound, pass through inbound', () => {
  const map = new ToolNameMap(['fs:read_file'])
  // a hallucinated tool name from the model is not in the map — pass through
  // so the registry's "not registered" error path still fires
  assert.equal(map.toInternal('hallucinated_tool'), 'hallucinated_tool')
  assert.equal(map.toInternal('fs__read_file'), 'fs:read_file')
  assert.equal(map.toLlm('some:unknown'), 'some__unknown')
})

test('the investment task whitelist produces a fully provider-safe tools array', () => {
  // The exact failure: investment = 10 built-ins + fs:* MCP tools; before the
  // fix tools[10] was `fs:read_file`. After sanitization every name validates.
  const whitelist = [
    'read-file',
    'write-file',
    'shell',
    'skill-run',
    'fs:read_file',
    'fs:read_text_file',
    'fs:read_media_file',
    'fs:read_multiple_files',
    'fs:write_file',
    'fs:edit_file',
    'fs:create_directory',
    'fs:list_directory',
    'fs:list_directory_with_sizes',
    'fs:directory_tree',
    'fs:move_file',
    'fs:search_files',
    'fs:get_file_info',
    'fs:list_allowed_directories',
    'portfolio-check',
    'stock-scan',
    'csv-analyze',
    'product-analyze',
    'pse-review',
    'pse-review-latest',
  ]
  const map = new ToolNameMap(whitelist)
  const llmNames = whitelist.map((n) => map.toLlm(n))
  assert.equal(llmNames[4], 'fs__read_file', 'the old tools[10] offender is now valid')
  for (const n of llmNames) assert.match(n, /^[a-zA-Z0-9_-]+$/)
  // and the reverse mapping restores every canonical name
  assert.deepEqual(
    llmNames.map((n) => map.toInternal(n)),
    whitelist,
  )
})
