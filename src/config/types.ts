export interface ProviderConfig {
  type: string
  baseUrl: string
  apiKey?: string
}

export interface OrchestratorConfig {
  model?: string
  provider?: ProviderConfig
}

export interface ContextBudget {
  systemPrompt: number
  responseReserve: number
  compactionThreshold: number
}

export interface SessionConfig {
  autoSave: boolean
  maxSessions: number
  isolateMemory: boolean
}

export interface AppConfig {
  version: string
  model: string
  provider: ProviderConfig
  orchestrator: OrchestratorConfig
  contextWindow: number
  contextBudget: ContextBudget
  maxToolIterations: number
  stuckThreshold: number
  autoPlan: boolean
  showReasoning: boolean
  logLevel: string
  locale: string
  session: SessionConfig
}
