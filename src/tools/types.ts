export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

export interface ToolContext {
  config: import('../config/types').AppConfig
  baseDir: string
  logger: import('../logger/app-logger').Logger
  sessionHistory?: {
    append(type: string, content: unknown): Promise<void>
  }
}

export interface ToolResult {
  success: boolean
  output: string
  toolCallId?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface PluginHook {
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | Promise<boolean>
  onAfterTool?(ctx: ToolContext, result: ToolResult): void | Promise<void>
}

export interface PluginManager {
  getAllPlugins(): PluginHook[]
}
