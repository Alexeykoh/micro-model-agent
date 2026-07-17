export interface ModelConfig {
  model: string;
  contextWindow: number;
  params: ModelParams;
}

export interface ModelParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number | null;
  [key: string]: unknown;
}

export interface ProviderConfig {
  type: string;
  url: string;
  apiKey: string | null;
  models: Record<string, ModelConfig>;
}

export interface ActiveConfig {
  provider: string;
  model: string;
}

export interface AgentConfig {
  maxSteps: number;
  autoCompact: boolean;
  compactThreshold: number;
  toolTimeout: number;
  maxOutputLength: number;
  filterThinking?: boolean;
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  active: ActiveConfig;
  agent: AgentConfig;
  theme?: string;
}
