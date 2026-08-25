import { Context } from 'cordis'
import { ToolRegistry } from './src/services/tools.ts'
import { toolBrowser } from './src/plugins/tool-browser.ts'
const root = new Context()
await root.plugin(ToolRegistry)
await root.plugin(toolBrowser)
const res = await root.tools.call('browser-open', JSON.stringify({ url: 'https://example.com' }))
console.log(res.slice(0, 220))
await root.fiber.dispose()
