import { Context } from 'cordis'
import { ToolRegistry } from './src/services/tools.ts'
import { toolPseReview } from './src/plugins/tool-pse-review.ts'
const root = new Context()
await root.plugin(ToolRegistry)
await root.plugin(toolPseReview)
console.log('--- calling pse-review (full pipeline, may take minutes) ---')
const res = await root.tools.call('pse-review', '{}')
console.log('--- result head ---')
console.log('bytes:', res.length)
console.log(res.slice(0, 500))
await root.fiber.dispose()
console.log('DONE')
