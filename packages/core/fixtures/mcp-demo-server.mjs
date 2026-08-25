/**
 * Minimal stdio MCP server used by the test suite.
 * Exposes one tool (`greet`) so the MCP client path can be verified
 * end-to-end without any network or external services.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'demo-mcp', version: '1.0.0' })

server.tool(
  'greet',
  { name: z.string().describe('who to greet') },
  async ({ name }) => ({
    content: [{ type: 'text', text: `hello ${name}` }],
  }),
)

server.tool(
  'add',
  { a: z.number(), b: z.number() },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
)

await server.connect(new StdioServerTransport())
