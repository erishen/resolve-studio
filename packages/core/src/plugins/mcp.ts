/**
 * MCP plugin — connect the harness to Model Context Protocol servers.
 *
 * `McpService` (ctx.mcp) manages MCP servers at runtime:
 *   - servers from `cordis*.yml` config are connected at startup;
 *   - servers added via the UI (POST /api/mcp) are persisted to
 *     `<cwd>/.data/mcp-servers.json` and reconnected on the next boot;
 *   - each server's tools are dynamically registered into `ctx.tools`
 *     (prefixed `<serverId>:<toolName>`), so the agent can call external
 *     capabilities like any built-in tool;
 *   - `connect` / `disconnect` / `list` power the management API and UI.
 *
 * Security posture: MCP tools default to `needsApproval: true` — external
 * capabilities can be powerful, so every call is human-gated unless a server
 * explicitly opts out (`approval: false` for read-only servers). A failed
 * server never crashes the composition: it records an `error` state and the
 * rest of the harness keeps running.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Context, Service } from 'cordis'
import type { Tool, ToolParameter } from '../types.js'
import { definePlugin } from './util.js'

export interface McpServerConfig {
  /** Unique id; becomes the tool-name prefix (`<id>:<tool>`). */
  id: string
  transport: 'stdio' | 'http'
  /** stdio: the command to spawn (e.g. `npx`). */
  command?: string
  /** stdio: arguments to the command. */
  args?: string[]
  /** stdio: extra environment variables. */
  env?: Record<string, string>
  /** http: the MCP endpoint URL (Streamable HTTP). */
  url?: string
  /** Override the default approval gate (default: true → tools need approval). */
  approval?: boolean
}

export interface McpConfig {
  servers?: McpServerConfig[]
}

export interface McpStatus {
  id: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  approval: boolean
  status: 'connected' | 'error'
  toolCount: number
  /** Registered tool names (empty until connected). */
  tools: string[]
  error?: string
}

interface ConnectedServer {
  client: Client
  close: () => Promise<void>
}

declare module 'cordis' {
  interface Context {
    mcp: McpService
  }
}

const PERSISTED_FILE = join(process.cwd(), '.data', 'mcp-servers.json')

async function connectServer(s: McpServerConfig): Promise<ConnectedServer> {
  const client = new Client({ name: 'agent-harness', version: '0.1.0' })
  if (s.transport === 'http') {
    if (!s.url) throw new Error(`mcp server "${s.id}" (http) needs a url`)
    const transport = new StreamableHTTPClientTransport(new URL(s.url))
    await client.connect(transport, { timeout: 120_000 })
  } else {
    if (!s.command) throw new Error(`mcp server "${s.id}" (stdio) needs a command`)
    const transport = new StdioClientTransport({
      command: s.command,
      args: s.args ?? [],
      env: s.env,
    })
    await client.connect(transport, { timeout: 120_000 })
  }
  return { client, close: () => client.close() }
}

function formatMcpResult(raw: unknown): string {
  const res = raw as {
    content?: { type?: string; text?: string }[]
    isError?: boolean
    structuredContent?: unknown
  }
  if (res.isError) {
    const text = (res.content ?? []).map((c) => c.text ?? '').join('')
    return `error: ${text || 'mcp tool failed'}`
  }
  if (res.structuredContent !== undefined) return JSON.stringify(res.structuredContent)
  return (res.content ?? []).map((c) => c.text ?? '').filter(Boolean).join('\n')
}

export class McpService extends Service {
  static inject = { tools: {} }

  private readonly clients = new Map<string, ConnectedServer>()
  private readonly toolNames = new Map<string, string[]>()
  private readonly states = new Map<string, McpStatus>()
  /** Servers added at runtime (persisted across restarts). */
  private readonly persisted: McpServerConfig[] = []
  private readonly persistedFile: string

  constructor(ctx: Context, config: McpConfig = {}) {
    super(ctx, 'mcp')
    this.persistedFile = PERSISTED_FILE
    // Fire-and-forget: startup connections are async; failures are recorded,
    // never fatal. yml servers first, then persisted user-added ones.
    void this.init(config.servers ?? [])
  }

  private async init(ymlServers: McpServerConfig[]): Promise<void> {
    await this.loadPersisted()
    const merged = [...ymlServers]
    for (const p of this.persisted) {
      if (!merged.some((s) => s.id === p.id)) merged.push(p)
    }
    for (const s of merged) {
      await this.connect(s)
    }
  }

  private async loadPersisted(): Promise<void> {
    try {
      const raw = await readFile(this.persistedFile, { encoding: 'utf8' })
      const list = JSON.parse(raw) as McpServerConfig[]
      this.persisted.push(...Array.isArray(list) ? list : [])
      if (list.length) {
        this.ctx.logger('mcp').info('restored %d server(s) from %s', list.length, this.persistedFile)
      }
    } catch (err) {
      // ENOENT is fine (first run); anything else is worth logging.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.ctx.logger('mcp').warn('load persisted servers failed: %s', (err as Error).message)
      }
    }
  }

  private async savePersisted(): Promise<void> {
    try {
      await mkdir(dirname(this.persistedFile), { recursive: true })
      await writeFile(this.persistedFile, JSON.stringify(this.persisted, null, 2))
    } catch (err) {
      this.ctx.logger('mcp').warn('persist servers failed: %s', (err as Error).message)
    }
  }

  /** Connect (or reconnect) a server and register its tools. */
  async connect(config: McpServerConfig, opts: { persist?: boolean } = {}): Promise<McpStatus> {
    // Reconnecting must NOT touch `this.persisted` — otherwise startup
    // (init → connect(persistedServer)) would wipe the saved config and the
    // file would be rewritten as `[]` on every boot. Only an explicit user
    // DELETE should drop persisted state, via `disconnect`.
    await this.unregisterConnection(config.id)
    const status: McpStatus = {
      id: config.id,
      transport: config.transport,
      command: config.command,
      args: config.args,
      url: config.url,
      approval: config.approval ?? true,
      status: 'error',
      toolCount: 0,
      tools: [],
    }
    try {
      const connected = await connectServer(config)
      const { tools } = await connected.client.listTools()
      const names: string[] = []
      for (const t of tools) {
        const name = `${config.id}:${t.name}`
        names.push(name)
        this.ctx.tools.register({
          name,
          description: t.description ?? `MCP tool from server "${config.id}"`,
          parameters: (t.inputSchema ?? { type: 'object' }) as ToolParameter,
          needsApproval: status.approval,
          async execute(args) {
            const res = await connected.client.callTool({ name: t.name, arguments: args })
            return formatMcpResult(res)
          },
        } satisfies Tool)
      }
      this.clients.set(config.id, connected)
      this.toolNames.set(config.id, names)
      status.status = 'connected'
      status.toolCount = names.length
      status.tools = names
      this.ctx.logger('mcp').info('server "%s" connected: %d tool(s)', config.id, names.length)
    } catch (err) {
      status.error = (err as Error).message
      this.ctx.logger('mcp').warn('server "%s" failed: %s', config.id, status.error)
    }
    this.states.set(config.id, status)
    if (opts.persist) {
      // Replace if editing an existing id, otherwise append — so editing a
      // server keeps the persisted config in sync with the new one.
      const idx = this.persisted.findIndex((s) => s.id === config.id)
      if (idx >= 0) this.persisted[idx] = config
      else this.persisted.push(config)
      await this.savePersisted()
    }
    return status
  }

  /**
   * Tear down a server's live connection and unregister its tools WITHOUT
   * touching `this.persisted`. Used by `connect` so re-connecting (at startup
   * or when editing an existing id) never wipes the persisted config.
   */
  private async unregisterConnection(id: string): Promise<void> {
    const connected = this.clients.get(id)
    if (connected) {
      await connected.close().catch(() => {})
      this.clients.delete(id)
    }
    for (const name of this.toolNames.get(id) ?? []) {
      this.ctx.tools.unregister(name)
    }
    this.toolNames.delete(id)
    this.states.delete(id)
  }

  /** Disconnect a server, unregister its tools, drop persisted state. */
  async disconnect(id: string): Promise<boolean> {
    const had = this.states.has(id)
    await this.unregisterConnection(id)
    const idx = this.persisted.findIndex((s) => s.id === id)
    if (idx >= 0) {
      this.persisted.splice(idx, 1)
      await this.savePersisted()
    }
    return had
  }

  /** Current servers with status. */
  async list(): Promise<McpStatus[]> {
    return [...this.states.values()]
  }

  protected async stop() {
    for (const { close } of this.clients.values()) {
      // Await so stdio child processes are actually reaped — otherwise the
      // test runner / process exit hangs on the lingering child handles.
      await close().catch(() => {})
    }
    this.clients.clear()
    this.toolNames.clear()
    this.states.clear()
  }
}

export const mcpPlugin = definePlugin(McpService, 'mcp', ['tools'])
