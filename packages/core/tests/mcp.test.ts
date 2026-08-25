/**
 * Regression test for the MCP persistence bug.
 *
 * Root cause (fixed 2026-08-25): `connect()` used to call `disconnect()` at its
 * top, and `disconnect()` dropped the server from the in-memory `persisted`
 * array AND rewrote the file. At boot, `init()` does `loadPersisted()` (filling
 * `persisted`) and then `connect()`s each restored server — which wiped the just
 * loaded config and rewrote the file as `[]`. So every restart emptied the user's
 * MCP servers.
 *
 * This test pins the contract: a persisted server must survive a boot reconnect
 * (file keeps it), and only an explicit `disconnect()` (user DELETE) removes it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from 'cordis'
import { ToolRegistry } from '../src/services/tools.js'
import { mcpPlugin } from '../src/plugins/mcp.js'

// Mirrors the module-level PERSISTED_FILE in mcp.ts (cwd/.data/mcp-servers.json).
const PERSISTED = join(process.cwd(), '.data', 'mcp-servers.json')

const DEMO = {
  id: 'demo',
  transport: 'stdio' as const,
  command: 'no-such-mcp-server-xyz', // instantly fails to spawn → connect() errors fast, but persist still writes
  approval: true,
}

async function buildContext(): Promise<Context> {
  const root = new Context()
  await root.plugin(ToolRegistry)
  await root.plugin(mcpPlugin)
  return root
}

async function waitForServer(ctx: Context, id: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const servers = await ctx.mcp.list()
    if (servers.some((s) => s.id === id)) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`server "${id}" never appeared after reconnect`)
}

test('persisted MCP server survives a boot reconnect (no data loss)', async () => {
  // Back up any pre-existing file so the test never destroys real config.
  let backup: string | null = null
  try {
    backup = await readFile(PERSISTED, 'utf8')
  } catch {
    backup = null
  }

  let ctx1!: Context
  let ctx2!: Context
  try {
    // 1) First session: user adds a server (persist: true) via the UI/API.
    ctx1 = await buildContext()
    await ctx1.mcp.connect({ ...DEMO }, { persist: true })

    const written = JSON.parse(await readFile(PERSISTED, 'utf8'))
    assert.deepEqual(
      written.map((s: { id: string }) => s.id),
      ['demo'],
      'connect(persist) should write the server to disk',
    )

    // 2) Simulate a restart: a fresh context re-reads and reconnects persisted
    //    servers. The on-disk config MUST NOT be wiped by the reconnect path.
    ctx2 = await buildContext()
    await waitForServer(ctx2, 'demo')

    const afterReconnect = JSON.parse(await readFile(PERSISTED, 'utf8'))
    assert.deepEqual(
      afterReconnect.map((s: { id: string }) => s.id),
      ['demo'],
      'a boot reconnect must NOT clear the persisted MCP server (regression)',
    )

    const restored = await ctx2.mcp.list()
    assert.ok(
      restored.some((s) => s.id === 'demo'),
      'the server should be restored into the running state after boot',
    )

    // 3) Only an explicit disconnect (user DELETE) should drop persisted state.
    const ok = await ctx2.mcp.disconnect('demo')
    assert.equal(ok, true, 'disconnect should report the server existed')
    const afterDelete = JSON.parse(await readFile(PERSISTED, 'utf8'))
    assert.deepEqual(afterDelete, [], 'disconnect should remove the server from disk')
  } finally {
    if (ctx1) await ctx1.fiber.dispose()
    if (ctx2) await ctx2.fiber.dispose()
    // Restore or clean up the test file.
    if (backup !== null) await writeFile(PERSISTED, backup)
    else await rm(PERSISTED, { force: true })
  }
})
