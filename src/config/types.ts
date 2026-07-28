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
  logLevel: string
  locale: string
}
