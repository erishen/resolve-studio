import { Context, Service } from 'cordis'
import { definePlugin } from './src/plugins/util.ts'

class Usage extends Service {
  constructor(ctx) { super(ctx, 'usage') }
  snapshot() { return { ok: true } }
}
const usagePlugin = definePlugin(Usage, 'usage', [])

// webServer does NOT inject usage; reads it from the root registry context.
const fnPlugin = definePlugin((ctx, config = {}) => {
  console.log('=== Scenario A: usage provided, webServer does NOT inject usage ===')
  try {
    const svc = ctx.registry?.ctx?.usage
    console.log('[A] ctx.registry.ctx.usage ->', svc ? 'OK' : 'undefined')
    console.log('[A] snapshot:', svc ? JSON.stringify(svc.snapshot()) : 'n/a')
  } catch (e) {
    console.log('[A] ERR', e.message)
  }
}, 'web-server', []) // note: NO 'usage' in inject

// Scenario B: usage NOT provided at all
const fnPluginB = definePlugin((ctx) => {
  console.log('=== Scenario B: usage NOT provided, webServer does NOT inject usage ===')
  try {
    const svc = ctx.registry?.ctx?.usage
    console.log('[B] ctx.registry.ctx.usage ->', svc ? 'OK' : 'undefined')
  } catch (e) {
    console.log('[B] ERR', e.message)
  }
}, 'web-server-b', [])

// A
const root = new Context()
await root.plugin(usagePlugin)
await root.plugin(fnPlugin)

// B
const root2 = new Context()
await root2.plugin(fnPluginB)
