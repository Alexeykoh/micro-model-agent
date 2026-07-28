import type { ToolDefinition } from './types'

export const mcpCallTool: ToolDefinition = {
  name: 'mcp_call',
  description: 'Call a tool on an external MCP server. Servers are registered in config.',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the server' },
      args: { type: 'object', description: 'Tool arguments' },
    },
    required: ['server', 'tool'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[MCP call: ${args.server}/${args.tool}]` }
  },
}
