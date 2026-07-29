import type { ToolContext, ToolCall, ToolResult, PluginManager } from './types'
import { ToolRegistry } from './registry'

export class ToolExecutor {
  private registry: ToolRegistry
  private ctx: ToolContext
  private pluginManager: PluginManager

  constructor(registry: ToolRegistry, ctx: ToolContext, pluginManager: PluginManager) {
    this.registry = registry
    this.ctx = ctx
    this.pluginManager = pluginManager
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name)
    if (!tool) {
      return { success: false, output: `Unknown tool: ${call.name}`, toolCallId: call.id }
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onBeforeTool) {
        try {
          const proceed = await plugin.onBeforeTool(this.ctx, call)
          if (!proceed) {
            return { success: false, output: `Blocked by plugin: ${plugin.constructor?.name || 'unknown'}`, toolCallId: call.id }
          }
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onBeforeTool error: ${e.message}`)
        }
      }
    }

    let result: ToolResult
    try {
      result = await tool.handler(this.ctx, call.arguments)
      result.toolCallId = call.id
    } catch (e: any) {
      result = { success: false, output: `Error: ${e.message}`, toolCallId: call.id }
    }

    for (const plugin of this.pluginManager.getAllPlugins()) {
      if (plugin.onAfterTool) {
        try {
          await plugin.onAfterTool(this.ctx, result)
        } catch (e: any) {
          this.ctx.logger.warn(`Plugin onAfterTool error: ${e.message}`)
        }
      }
    }

    this.ctx.logger.info(`Tool ${call.name}: ${result.success ? 'OK' : 'FAIL'}`)
    return result
  }

  getToolDefinitions(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.registry.getAllForLLM()
  }
}
