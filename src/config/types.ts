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
  baselineCheck?: boolean;
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

export interface UiConfig {
  spinner: boolean;
}

export interface BashSecurityConfig {
  enabled: boolean;
  blacklist: string[];
  whitelist: string[];
  blockDangerousFlags: boolean;
  logCommands: boolean;
  dangerousFlags: string[];
  dangerousOperators: string[];
}

export interface PathSecurityConfig {
  enabled: boolean;
  denied: string[];
  allowed: string[];
}

export interface NetworkSecurityConfig {
  enabled: boolean;
  deniedDomains: string[];
  allowedDomains: string[];
  requestTimeout: number;
  maxResponseSize: number;
}

export interface RateLimitConfig {
  maxRequestsPerMinute: number;
  maxParallelTasks: number;
}

export interface ContentScanConfig {
  enabled: boolean;
  dangerousPatterns: RegExp[];
}

export interface SecurityConfig {
  enabled: boolean;
  bash: BashSecurityConfig;
  paths: PathSecurityConfig;
  network: NetworkSecurityConfig;
  maxRecursionDepth: number;
  maxFileOperations: number;
  rateLimits: RateLimitConfig;
  contentScan: ContentScanConfig;
  sessionEncryption: SessionEncryptionConfig;
  auditNotifier: AuditNotifierConfig;
}

export interface SessionIsolationConfig {
  enabled: boolean;
  isolatePlugins: boolean;
  isolateTempFiles: boolean;
}

export interface SessionEncryptionConfig {
  enabled: boolean;
  encryptHistory: boolean;
  encryptSessionLog: boolean;
  keyPath?: string;
}

export type AuditEventType =
  | "security_block"
  | "bash_command"
  | "file_operation"
  | "network_request"
  | "tool_call"
  | "authentication"
  | "configuration_change"
  | "session_start"
  | "session_end";

export interface AuditNotifierConfig {
  enabled: boolean;
  filePath?: string;
  webhookUrl?: string;
  webhookTimeout?: number;
  minSeverity?: "low" | "medium" | "high" | "critical";
  eventTypes?: AuditEventType[];
  maxRetries?: number;
}

import type { LspConfig, LspServerConfig } from '../modules/lsp/types'

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
  ui: UiConfig;
  mcpServers: Record<string, MCPServerConfigEntry>;
  security?: SecurityConfig;
  sessionIsolation?: SessionIsolationConfig;
  lsp?: LspConfig;
}
