import type { PromptBlock } from '../core/types'
import type { ToolDefinition } from '../tools/types'

export interface AgentModule {
  name: string
  getSystemPromptBlock?(): PromptBlock | null
  getToolDefinitions?(): ToolDefinition[]
  getPlugin?(): AgentPlugin
}

export interface AgentPlugin {
  name: string
  priority?: number
  onBuildPrompt?(): string | null
  onBeforeTool?(ctx: any, call: any): boolean | Promise<boolean>
  onAfterTool?(ctx: any, result: any): void | Promise<void>
  onBeforeThink?(ctx: any): void
  onError?(ctx: any, error: Error): void
  onSessionStart?(ctx: any): void
  onSessionEnd?(ctx: any): void
}
