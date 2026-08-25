/**
 * Unit tests for {@link needsApprovalFor} — the tool-level MCP approval policy
 * that replaces the old server-wide boolean (docs/TODO.md "审批粒度仅服务器级布尔").
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { needsApprovalFor } from '../src/plugins/mcp.js'

test('needsApprovalFor: undefined / true → always needs approval', () => {
  assert.equal(needsApprovalFor('fs:read_file', undefined), true)
  assert.equal(needsApprovalFor('fs:write_file', true), true)
})

test('needsApprovalFor: false → never needs approval', () => {
  assert.equal(needsApprovalFor('fs:read_file', false), false)
  assert.equal(needsApprovalFor('fs:write_file', false), false)
})

test('needsApprovalFor: allow list → only listed tools auto-approved', () => {
  const policy = { allow: ['fs:read_file', 'fs:list_dir'] }
  assert.equal(needsApprovalFor('fs:read_file', policy), false, 'listed → auto-approved')
  assert.equal(needsApprovalFor('fs:list_dir', policy), false, 'listed → auto-approved')
  assert.equal(needsApprovalFor('fs:write_file', policy), true, 'not listed → still gated')
})

test('needsApprovalFor: deny list → listed tools stay gated under false', () => {
  const policy = { allow: ['fs:read_file'], deny: ['fs:write_file'] }
  assert.equal(needsApprovalFor('fs:read_file', policy), false, 'allow wins for non-denied')
  assert.equal(needsApprovalFor('fs:write_file', policy), true, 'deny keeps it gated')
  assert.equal(needsApprovalFor('fs:delete', policy), true, 'unlisted → gated')
})

test('needsApprovalFor: empty allow list → everything gated', () => {
  assert.equal(needsApprovalFor('fs:read_file', { allow: [] }), true)
})
