/** A single configured provider (one of possibly many). */
export interface ProviderEntry {
  /** Registry type: "openai-compat" | "openrouter" | "openai" | "opencode-zen" | ... */
  type: string;
  /** User-facing name (defaults to type when empty). */
  label?: string;
  baseUrl: string;
  apiKey?: string;
  contextWindow?: number;
  retry?: RetryConfig;
  rateLimits?: RateLimitConfig;
  /** Fallback order (lower = tried first). */
  priority?: number;
}

export interface ProviderConfig {
  /**
   * Name/label of the active provider (matches a `ProviderEntry.label` or
   * `.type`). When `entries` is absent, this is a single-provider legacy
   * config and `type`/`baseUrl`/`apiKey` apply.
   */
  active?: string;
  /** All configured providers (multi-provider mode). */
  entries?: ProviderEntry[];
  /** Auto-failover to the next provider on 429/5xx (default false). */
  fallback?: boolean;
  // Legacy single-provider fields — kept working (mirror the active entry).
  type: string;
  baseUrl: string;
  apiKey?: string;
}

/** Price of a model in USD per 1M tokens (input / output). */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * Tariff / cost tracking. `overrides` lets the user set or override per-model
 * prices (USD per 1M tokens) manually; `builtin` tables cover known providers
 * (OpenCode Zen / Go). When no price is known, cost is not shown.
 */
export interface PricingConfig {
  /** Master switch for cost tracking and display. */
  enabled: boolean;
  /** User-supplied per-model prices (model id -> {input, output}). */
  overrides: Record<string, ModelPrice>;
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

export interface ToolsConfig {
  /**
   * Tool tags always exposed to the LLM in the main agent loop. Tools not
   * matching these tags (and not `alwaysOn`) are hidden from the schema and
   * must be enabled on demand via the `enable_tools` tool or routed to MoE
   * experts / subagents.
   */
  defaultTags: string[];
  /**
   * Master switch for the `enable_tools` on-demand tool. When false, the tool
   * is not registered and the tag set stays empty — the legacy behavior of
   * exposing every registered tool is restored.
   */
  enableOnDemand: boolean;
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
  maxContentChars: number;
  maxConsoleEntries: number;
  maxConsoleLineChars: number;
  viewportWidth: number;
  viewportHeight: number;
  navigationTimeout: number;
}

export interface UiConfig {
  spinner: boolean;
  /** Tool display style: "inline" (opencode-like headers, no boxes) or "box". */
  toolStyle: "box" | "inline";
  /** Show model commentary text that accompanies a tool call (sanitized). */
  toolComments: boolean;
  /** Show context usage bar after each tool cycle (ctx: N/M, compactions, quality). */
  showContextStats: boolean;
  /** Show a one-line indicator when context compaction happens. */
  showCompaction: boolean;
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

/**
 * Master switch for the web search capability. When enabled=false the
 * web_search tool replies "disabled" and the automatic error search
 * (errorWebSearch) never fires — the feature is tied to this switch.
 */
export interface WebSearchConfig {
  enabled: boolean;
}

export interface ErrorWebSearchConfig {
  /** Independent switch for the auto error-search feature itself. */
  enabled: boolean;
  /** Same error signature repetition count that triggers the search (5). */
  threshold: number;
  /** Number of results injected into the context (5). */
  maxResults: number;
  /** Maximum length of the generated search query (200). */
  maxQueryChars: number;
  /** Session cap on automatic error searches (3). */
  maxSearchesPerSession: number;
  /** Network request timeout for the search in ms (10000). */
  requestTimeoutMs: number;
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

export interface SkillsConfig {
  budget: number;
}

export interface SubagentConfig {
  /**
   * "text" (default, backward compatible): sub-agent result text is returned
   * into the parent context. "file": the result is persisted to an artifact
   * file and the parent receives a path + bounded summary.
   */
  resultMode: "text" | "file";
  /** Max chars of the summary returned into context when resultMode is "file". */
  maxSummaryChars: number;
  /** Directory relative to the workspace root for artifact files. */
  artifactsDir: string;
  /** Keep the sub-agent system prompt byte-identical across calls (KV-cache friendly). */
  stableSystemPrompt: boolean;
  /** Default cap on parallel chunk queries in runChunkQuery. */
  maxParallelChunkQueries: number;
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

import type { LspConfig, LspServerConfig } from "../modules/lsp/types";

export interface UpdaterConfig {
  enabled: boolean;
  /** Check for updates asynchronously at startup (non-blocking). */
  checkOnStart: boolean;
  /** Automatically run `npm install -g` when a newer version is found. */
  autoInstall: boolean;
  /** Ms between background update checks. 0 = single check at startup. */
  intervalMs: number;
}

export interface AppConfig {
  version: string;
  model: string;
  provider: ProviderConfig;
  orchestrator: OrchestratorConfig;
  moe: MoeConfig;
  experts: Record<string, ExpertConfig>;
  tools: ToolsConfig;
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
  webSearch?: WebSearchConfig;
  errorWebSearch?: ErrorWebSearchConfig;
  pricing?: PricingConfig;
  ui: UiConfig;
  mcpServers: Record<string, MCPServerConfigEntry>;
  security?: SecurityConfig;
  sessionIsolation?: SessionIsolationConfig;
  skills: SkillsConfig;
  subagent: SubagentConfig;
  lsp?: LspConfig;
  updater: UpdaterConfig;
}
