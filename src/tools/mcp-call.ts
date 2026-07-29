import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const mcpCallTool: ToolDefinition = {
  name: 'mcp_call',
  description: 'Call a tool on an MCP (Model Context Protocol) server.',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the server' },
      args: { type: 'object', description: 'Arguments to pass to the tool' },
    },
    required: ['server', 'tool'],
  },
  handler: async (_ctx, args) => {
    const server = String(args.server || '')
    const tool = String(args.tool || '')
    const toolArgs = args.args || {}
    return { success: true, output: t('tool.mcp_call', { server, tool, args: JSON.stringify(toolArgs) }) }
  },
}
