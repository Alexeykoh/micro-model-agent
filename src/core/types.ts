export type AgentState = 'INIT' | 'THINK' | 'ACT' | 'OBSERVE' | 'OUTPUT' | 'ERROR'

export interface PromptBlock {
  content: string
  priority: 'critical' | 'high' | 'normal' | 'low'
  essential: boolean
  estimatedTokens: number
}

export type ToolCallStatus = 'done' | 'failed' | 'skipped'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  success: boolean
  output: string
  toolCallId?: string
}

export type LLMResponse =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; calls: ToolCall[] }
  | { type: 'reasoning'; content: string }

export interface AgentContext {
  state: AgentState
  config: import('../config/types').AppConfig
  messages: Array<{ role: string; content: string }>
  toolResults: ToolResult[]
  iterationCount: number
  currentStep?: number
  totalSteps?: number
}

export interface AgentModule {
  name: string
  getSystemPromptBlock?(): PromptBlock | null
  getToolDefinitions?(): import('../tools/types').ToolDefinition[]
  getPlugin?(): import('../modules/plugins/types').AgentPlugin
}

export interface HallucinationResult {
  status: 'pass' | 'warn' | 'retry' | 'block'
  reason?: string
}
