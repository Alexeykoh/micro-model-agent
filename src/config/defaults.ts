import type { AppConfig } from './types'

export const DEFAULTS: AppConfig = {
  version: '2.0.0',
  model: 'qwen3.5-9b',
  provider: {
    type: 'openai-compat',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'not-needed',
  },
  orchestrator: {
    model: undefined,
    provider: undefined,
  },
  contextWindow: 32768,
  contextBudget: {
    systemPrompt: 0.25,
    responseReserve: 0.12,
    compactionThreshold: 0.75,
  },
  modelLoad: {
    autoLoad: false,
    flashAttention: true,
    offloadKvCacheToGpu: true,
  },
  retry: {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
  },
  maxToolIterations: 25,
  stuckThreshold: 8,
  autoPlan: true,
  showReasoning: true,
  logLevel: 'info',
  locale: 'en',
  session: {
    autoSave: true,
    maxSessions: 50,
    isolateMemory: false,
  },
}
