export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  tags?: string[]
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

export interface ToolScope {
  allowed_files: string[]
  read_only_files: string[]
}

export interface ToolContext {
  config: import('../config/types').AppConfig
  baseDir: string
  logger: import('../logger/app-logger').Logger
  scope?: ToolScope
  llmProvider?: import('../llm/provider').LLMProvider
  toolExecutor?: import('./executor').ToolExecutor
  contextManager?: import('../modules/context/manager').ContextManager
  sessionHistory?: {
    append(type: string, content: unknown): Promise<void>
  }
}

export interface ToolResult {
  success: boolean
  output: string
  toolCallId?: string
  display?: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface PluginHook {
  name?: string
  priority?: number
  isBuiltin?: boolean
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | Promise<boolean>
  onAfterTool?(ctx: ToolContext, call: ToolCall, result: ToolResult): void | Promise<void>
}

export interface PluginManager {
  getAllPlugins(): PluginHook[]
}
