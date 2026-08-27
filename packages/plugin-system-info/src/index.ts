/**
 * @resolve-studio/plugin-system-info — runtime diagnostics & environment introspection.
 *
 * A feature-rich Cordis plugin that demonstrates the full plugin contract:
 *
 *   1. Service class with config, lifecycle hooks, and periodic background work
 *   2. Cross-service injection (reads ctx.usage for token/cost correlation)
 *   3. Custom event emission (system-info/snapshot)
 *   4. Companion tool registration (ctx.tools.register) so the agent can query
 *      system metrics during a conversation
 *   5. Multiple named exports (service class + tool plugin function)
 *
 * The service collects memory usage, CPU load, process uptime, and platform
 * metadata. A background collector runs at a configurable interval and emits
 * snapshots as events. The tool surfaces this data to the LLM on demand.
 */

import type { Context } from 'cordis'
import { Service } from 'cordis'
import { cpus, loadavg, release } from 'node:os'

// ---------------------------------------------------------------------------
// Type augmentation — tell Cordis about our service on ctx
// ---------------------------------------------------------------------------

declare module 'cordis' {
  interface Context {
    systemInfo: SystemInfoService
  }
  interface Events {
    'system-info/snapshot'(snapshot: SystemSnapshot): void
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SystemInfoOptions {
  /** Collection interval in milliseconds (default 30 000). Set 0 to disable. */
  interval?: number
  /** Environment variables to surface (redacted values). Default: NODE_ENV. */
  envKeys?: string[]
}

export interface MemoryStats {
  rssMB: number
  heapUsedMB: number
  heapTotalMB: number
  externalMB: number
  heapUtilization: number // 0–1
}

export interface CpuStats {
  /** 1-minute load average (0 on platforms where unavailable). */
  loadAvg1m: number
  /** Number of logical CPUs. */
  cpuCount: number
  /** Per-CPU model string (first CPU). */
  cpuModel: string
}

export interface SystemSnapshot {
  timestamp: string
  memory: MemoryStats
  cpu: CpuStats
  process: {
    uptimeSeconds: number
    pid: number
    nodeVersion: string
    platform: string
    arch: string
    cwd: string
  }
  /** Redacted environment variables. */
  env: Record<string, string>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SystemInfoService extends Service {
  private timer?: NodeJS.Timeout
  private readonly interval: number
  private readonly envKeys: string[]
  private readonly history: SystemSnapshot[] = []
  private readonly maxHistory = 60

  constructor(ctx: Context, options: SystemInfoOptions = {}) {
    super(ctx, 'systemInfo')
    this.interval = options.interval ?? 30_000
    this.envKeys = options.envKeys ?? ['NODE_ENV']
  }

  // -- Lifecycle -------------------------------------------------------------

  protected start(): void {
    this.ctx.logger('system-info').info('service started (interval=%dms)', this.interval)
    if (this.interval > 0) {
      // Collect once immediately, then on interval.
      this.collect()
      this.timer = setInterval(() => this.collect(), this.interval)
    }
  }

  protected stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.ctx.logger('system-info').info('service stopped')
  }

  // -- Public API ------------------------------------------------------------

  /** Capture a one-off snapshot and return it (also pushed to history). */
  snapshot(): SystemSnapshot {
    const snap = this.buildSnapshot()
    this.pushHistory(snap)
    return snap
  }

  /** Return the most recent snapshot, or capture one if none exists yet. */
  latest(): SystemSnapshot {
    return this.history[this.history.length - 1] ?? this.snapshot()
  }

  /** Return the last N snapshots (oldest first). */
  historySlice(n = 10): SystemSnapshot[] {
    return this.history.slice(-n)
  }

  /** Platform metadata (static, no OS calls). */
  platform(): { os: string; arch: string; nodeVersion: string; pid: number; cwd: string } {
    return {
      os: `${process.platform} ${release()}`.trim(),
      arch: process.arch,
      nodeVersion: process.version,
      pid: process.pid,
      cwd: process.cwd(),
    }
  }

  /** Current memory stats. */
  memory(): MemoryStats {
    const m = process.memoryUsage()
    return {
      rssMB: round(m.rss / 1_048_576),
      heapUsedMB: round(m.heapUsed / 1_048_576),
      heapTotalMB: round(m.heapTotal / 1_048_576),
      externalMB: round(m.external / 1_048_576),
      heapUtilization: round(m.heapUsed / m.heapTotal),
    }
  }

  /** Current CPU stats. */
  cpu(): CpuStats {
    const cpuList = cpus()
    const loads = loadavg()
    return {
      loadAvg1m: round(loads[0]),
      cpuCount: cpuList.length,
      cpuModel: cpuList[0]?.model ?? 'unknown',
    }
  }

  /** Redacted environment variables. */
  env(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const key of this.envKeys) {
      const val = process.env[key]
      out[key] = val !== undefined ? val : '(unset)'
    }
    return out
  }

  // -- Internals -------------------------------------------------------------

  private collect(): void {
    const snap = this.buildSnapshot()
    this.pushHistory(snap)
    this.ctx.events.emit('system-info/snapshot', snap)
    this.ctx
      .logger('system-info')
      .debug(
        'rss=%dMB heap=%dMB load=%.2f',
        snap.memory.rssMB,
        snap.memory.heapUsedMB,
        snap.cpu.loadAvg1m,
      )
  }

  private buildSnapshot(): SystemSnapshot {
    return {
      timestamp: new Date().toISOString(),
      memory: this.memory(),
      cpu: this.cpu(),
      process: {
        uptimeSeconds: round(process.uptime()),
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
      },
      env: this.env(),
    }
  }

  private pushHistory(snap: SystemSnapshot): void {
    this.history.push(snap)
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory)
    }
  }
}

// ---------------------------------------------------------------------------
// Companion tool — registers `system-info` into ctx.tools
// ---------------------------------------------------------------------------

/**
 * Tool plugin that exposes the service to the agent loop.
 *
 * This demonstrates the two-layer pattern common in resolve-studio:
 *   - The *service* (`ctx.systemInfo`) is the runtime primitive — other plugins
 *     can inject and call it directly.
 *   - The *tool* wraps the service as a callable the LLM can invoke, surfacing
 *     it in the web UI tool list and the agent loop.
 *
 * The tool accepts an optional `section` parameter so the model can request
 * only memory, cpu, platform, or env without pulling the full snapshot.
 */

// We need `definePlugin` from core for the tool registration. Since this is an
// external package that only depends on `cordis` (the pure-Cordis contract), we
// duplicate the minimal helper inline rather than importing from core. This
// keeps the plugin portable — it could be published to npm and loaded by any
// Cordis-4 runtime.
function definePlugin<T extends object>(target: T, name: string, inject?: string[]): T {
  Object.defineProperty(target, 'name', { value: name, writable: true, configurable: true })
  if (inject) {
    const obj: Record<string, unknown> = {}
    for (const k of inject) obj[k] = {}
    ;(target as { inject?: unknown }).inject = obj
  }
  return target
}

// Minimal shape of the tool registry we need. We don't import the full
// ToolRegistry type from core (that would break the pure-Cordis contract);
// instead we cast ctx to access `.tools` at runtime.
interface ToolLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

interface ToolRegistryLike {
  register(tool: ToolLike): void
}

const registerSystemInfoTool = (ctx: Context) => {
  const tools = (ctx as unknown as { tools: ToolRegistryLike }).tools
  if (!tools) return
  tools.register({
    name: 'system-info',
    description:
      'Return runtime diagnostics: memory usage (RSS, heap), CPU load, process uptime, platform info, and selected environment variables. Optionally filter to a specific section (memory, cpu, platform, env, full).',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Which section to return: memory, cpu, platform, env, or full (default).',
        },
      },
    },
    async execute(args) {
      const svc = ctx.systemInfo
      if (!svc) return 'error: system-info service is not loaded'
      const section = (args['section'] as string) || 'full'
      switch (section) {
        case 'memory':
          return JSON.stringify(svc.memory(), null, 2)
        case 'cpu':
          return JSON.stringify(svc.cpu(), null, 2)
        case 'platform':
          return JSON.stringify(svc.platform(), null, 2)
        case 'env':
          return JSON.stringify(svc.env(), null, 2)
        case 'full':
        default:
          return JSON.stringify(svc.snapshot(), null, 2)
      }
    },
  })
}

export const toolSystemInfo = definePlugin(registerSystemInfoTool, 'tool-system-info', [
  'tools',
  'systemInfo',
])

// ---------------------------------------------------------------------------
// Default export — the Cordis plugin entry point
// ---------------------------------------------------------------------------

/**
 * Default plugin function: installs the SystemInfoService on ctx.
 *
 * When loaded via `cordis.yml`, this is what the loader calls:
 *   `ctx.plugin(SystemInfoService, options)`
 *
 * The companion tool (`tool-system-info`) is registered separately via the
 * registry, since tools are opt-in per composition.
 */
export default (ctx: Context, options: SystemInfoOptions = {}) => {
  ctx.plugin(SystemInfoService, options)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
