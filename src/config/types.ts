export interface ProviderConfig {
  type: string;
  baseUrl: string;
  apiKey?: string;
}

export interface OrchestratorConfig {
  model?: string;
  provider?: ProviderConfig;
}

export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  compactionThreshold: number;
}

export interface SessionConfig {
  autoSave: boolean;
  maxSessions: number;
  isolateMemory: boolean;
}

export interface ModelLoadConfig {
  autoLoad: boolean;
  flashAttention?: boolean;
  evalBatchSize?: number;
  offloadKvCacheToGpu?: boolean;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

export interface MoeConfig {
  enabled: boolean;
}

export interface ExpertConfig {
  model: string;
  tool_tags: string[];
  max_attempts?: number;
}

export interface MCPHeader {
  [key: string]: string;
}

export interface MCPServerConfigEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: "stdio" | "sse" | "http";
  url?: string;
  headers?: MCPHeader;
  enabled?: boolean;
  timeout?: number;
}

export interface BrowserToolConfig {
  enabled: boolean;
  headless: boolean;
  maxElements: number;
  viewportWidth: number;
  viewportHeight: number;
  navigationTimeout: number;
}

export interface AppConfig {
  version: string;
  model: string;
  provider: ProviderConfig;
  orchestrator: OrchestratorConfig;
  moe: MoeConfig;
  experts: Record<string, ExpertConfig>;
  contextWindow: number;
  contextBudget: ContextBudget;
  modelLoad: ModelLoadConfig;
  retry: RetryConfig;
  maxToolIterations: number;
  stuckThreshold: number;
  autoPlan: boolean;
  showReasoning: boolean;
  logLevel: string;
  locale: string;
  session: SessionConfig;
  browser: BrowserToolConfig;
  mcpServers: Record<string, MCPServerConfigEntry>;
}
