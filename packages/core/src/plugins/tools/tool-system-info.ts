/**
 * `system-info` tool — surfaces the @resolve-studio/plugin-system-info service
 * to the agent as a callable tool.
 *
 * The service itself (`ctx.systemInfo`) is provided by the published
 * `@resolve-studio/plugin-system-info` package and loaded via `cordis.yml`
 * (loader path 2, dynamic import). This wrapper lives in core and only depends
 * on the service's *shape* at runtime — it never imports the package, keeping
 * core free of a hard dependency on any published plugin. This mirrors
 * tool-hello.ts exactly.
 */

import type { Context } from 'cordis'
import type { Tool } from '../../types.js'
import { definePlugin } from '../util.js'

declare module 'cordis' {
  interface Context {
    systemInfo?: SystemInfoLike
  }
}

interface SystemInfoLike {
  snapshot(): unknown
  memory(): unknown
  cpu(): unknown
  platform(): unknown
  env(): unknown
}

const registerSystemInfo = (ctx: Context) => {
  ctx.tools.register({
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
      if (!svc) return 'system-info service is not loaded in this composition'
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
  } satisfies Tool)
}

export const toolSystemInfo = definePlugin(registerSystemInfo, 'tool-system-info', [
  'tools',
  'systemInfo',
])
