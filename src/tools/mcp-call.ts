import { t } from '../i18n/index'
import type { ToolDefinition, ToolContext } from './types'
import { MCPClient } from '../modules/mcp/client'
import { MCPRegistry } from '../modules/mcp/registry'

const registry = new MCPRegistry()

export const mcpCallTool: ToolDefinition = {
  name: 'mcp_call',
  description: 'Call a tool on an MCP (Model Context Protocol) server. MCP servers provide external capabilities like databases, APIs, or specialized tools.',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the server' },
      args: { type: 'object', description: 'Arguments to pass to the tool' },
    },
    required: ['server', 'tool'],
  },
  handler: async (ctx: ToolContext, args) => {
    const serverName = String(args.server || '')
    const toolName = String(args.tool || '')
    const toolArgs = args.args || {}
    
    if (!serverName || !toolName) {
      return { success: false, output: 'Server and tool names are required' }
    }

    const serverConfig = registry.get(serverName)
    if (!serverConfig) {
      const available = registry.list()
      return { 
        success: false, 
        output: `MCP server "${serverName}" not found. Available: ${available.join(', ') || '(none)'}` 
      }
    }

    try {
      const client = new MCPClient(serverConfig)
      await client.connect()
      
      const result = await (client as any).callTool(toolName, toolArgs)
      
      await client.disconnect()
      
      return { 
        success: true, 
        output: `MCP call result:\n${JSON.stringify(result, null, 2)}` 
      }
    } catch (e: any) {
      return { success: false, output: `MCP call failed: ${e.message}` }
    }
  },
}
