/** Как провайдер предоставляет кеширование промпта. */
export type CacheMechanism = "auto" | "explicit" | "local" | "none";

/**
 * Формат ответа, которым провайдер сообщает о попадании в кеш.
 * `openai` покрывает OpenAI, LM Studio, llama.cpp, vLLM, OpenRouter, Zen/Go и
 * Gemini/xAI — все через OpenAI-совместимую форму.
 */
export type CacheReportFormat = "openai" | "deepseek" | "anthropic" | "ollama" | "none";

/**
 * Возможность кеширования промпта у провайдера. Описывает, КАК работает кеш и
 * что клиент обязан отправить, чтобы агент адаптировался под провайдера (см.
 * docs/specs/2026-09-17-prompt-caching-budget.md). Запросные флаги по
 * умолчанию false: включение — опция, потому что часть бэкендов (llama.cpp
 * `cache_prompt`) обменивает детерминизм на переиспользование.
 */
export interface CacheCapability {
  mechanism: CacheMechanism;
  report: CacheReportFormat;
  /** Слать `x-opencode-session` для кеш/sticky-маршрутизации (OpenCode Zen/Go). */
  sessionHeader: boolean;
  /** Слать `cache_prompt: true` в теле (llama.cpp). */
  requestCachePrompt: boolean;
  /** Слать `prompt_cache_key` в теле (OpenAI). */
  requestPromptCacheKey: boolean;
  /** Слать `session_id` в теле для sticky-маршрутизации (OpenRouter). */
  requestSessionId: boolean;
  /** Помечать блоки контента `cache_control` (Anthropic). */
  requestCacheControl: boolean;
  /**
   * Слать `stream_options: { include_usage: true }` в стриминге, чтобы бэкенд
   * вернул финальный usage-чанк (иначе многие OpenAI-совместимые серверы,
   * включая LM Studio, не отдают usage/`cached_tokens` в стриме).
   */
  requestStreamUsage: boolean;
}

/**
 * Возможности конкретной модели, уточняющие пресет провайдера. Единый
 * источник правды для тулов (например, browser/screenshot) вместо эвристики
 * по имени модели. Поля необязательны: слой может уточнять только часть.
 * Приоритет резолва — см. `resolveModelCapabilities`.
 */
export interface ModelCapabilities {
  /** Модель принимает изображения (image парты в сообщениях). */
  vision?: boolean;
  /** Модель умеет вызывать инструменты. */
  tools?: boolean;
}

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
  /** Completion token cap sent as max_tokens (default 8192). Raise for
   *  reasoning-heavy models that truncate tool_call arguments. */
  maxCompletionTokens?: number;
  /** Fallback order (lower = tried first). */
  priority?: number;
  /** Переопределения кеша для записи, накладываются на пресет провайдера. */
  cache?: Partial<CacheCapability>;
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
  /** Legacy flat completion cap (mirrored onto the normalized entry). */
  maxCompletionTokens?: number;
}

/** Цена модели в USD за 1M токенов. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Цена чтения из кеша (cache read). По умолчанию равна input. */
  cachedInput?: number;
  /** Цена записи в кеш (cache write). По умолчанию 0 (бесплатно). */
  cacheWrite?: number;
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
  /** Context window for the orchestrator model (default 32768; entry overrides). */
  contextWindow?: number;
}

export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  compactionThreshold: number;
  /**
   * Minimum history load (fraction) for the compaction iteration interval to
   * fire. Default 0.5. Prevents compacting a lightly-loaded context purely
   * because N iterations elapsed.
   */
  compactionMinLoad?: number;
}

/**
 * Handling of prompt blocks (AGENTS.md, project map) that exceed the
 * system-prompt budget. When `summarize` is on, the overflowing block is
 * summarized by the LLM into the remaining budget (cached in
 * `<project>/.mma/cache/prompt-summaries`); on failure the block is
 * truncated with a marker and the model is hinted to read the full file.
 */
export interface InstructionsConfig {
  summarize: boolean;
}

export interface SessionConfig {
  autoSave: boolean;
  maxSessions: number;
  isolateMemory: boolean;
}

/**
 * Git-style context log. When enabled, every LLM context snapshot is written to
 * `<session>/context.diff`: snapshot 0 is the full context (all lines "+"),
 * later snapshots are line diffs (- removed, + added). `redact` runs the
 * context through sanitizeLogMessage before writing.
 */
export interface ContextLogConfig {
  enabled: boolean;
  redact: boolean;
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
  /** Extra retries when the response stream breaks BEFORE any content is delivered. */
  maxStreamRetries?: number;
  /** Max silence (ms) between stream chunks before the connection is treated as dead. */
  noDataTimeoutMs?: number;
}

export interface MoeConfig {
  enabled: boolean;
  /** Max plan→execute→verify cycles per MoE run (initial cycle + N-1 re-plans). */
  maxReplanCycles?: number;
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
  /** One-line capability summary rendered into the MoE planner prompt. */
  description?: string;
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
  /** Show context usage bar after each tool cycle (ctx: N/M, compactions, quality). */
  showContextStats: boolean;
  /** Show a one-line indicator when context compaction happens. */
  showCompaction: boolean;
  /**
   * Chatty internal status: MoE planning/execution phases and other
   * orchestration one-liners. Off by default — these are meant for the
   * machine pipeline, not the user.
   */
  verbose?: boolean;
  /**
   * Chat verbosity level. `quiet` shows one line per action and hides tool
   * bodies; `verbose` shows full detail. Defaults to `quiet` for fresh
   * configs and falls back to `verbose ? "verbose" : "quiet"` when unset.
   * See `docs/design/ui/STYLE.md`.
   */
  verbosity?: "quiet" | "normal" | "verbose";
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

export interface HallucinationConfig {
  judge: {
    /**
     * Run an LLM-as-judge consistency pass on the worker model. Disabled by
     * default: on small models it adds up to 15s latency for a verdict that can
     * only produce a cosmetic "warn", never a retry/block.
     */
    enabled: boolean;
  };
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

import type { LspConfig, } from "../modules/lsp/types";

export interface UpdaterConfig {
  enabled: boolean;
  /** Check for updates asynchronously at startup (non-blocking). */
  checkOnStart: boolean;
  /** Automatically run `npm install -g` when a newer version is found. */
  autoInstall: boolean;
  /** Ms between background update checks. 0 = single check at startup. */
  intervalMs: number;
}

/** Reasoning effort levels aligned with opencode + OpenAI API. */
export type ReasoningLevel = "default" | "none" | "low" | "medium" | "high" | "max";

/**
 * How a provider expresses reasoning effort in the API request.
 * - "openai-effort": `reasoning_effort` field in body (OpenAI, OpenRouter, vLLM)
 * - "template-kwarg": backend-specific body field (llama.cpp `chat_template_kwargs`)
 * - "prompt-tag": tag appended to last user message (`/no_think` for Qwen)
 * - "none": unsupported — feature disabled
 */
export type ReasoningStrategy = "openai-effort" | "template-kwarg" | "prompt-tag" | "none";

/** Mode: "auto" = policy-driven dynamic control; anything else = fixed level. */
export type ReasoningMode = ReasoningLevel | "auto";

export interface ReasoningConfig {
  /** Active mode. "auto" = harness policy adjusts level per iteration. */
  mode: ReasoningMode;
  /** Minimum level in auto mode (clamp floor). */
  min: Exclude<ReasoningLevel, "default" | "auto">;
  /** Maximum level in auto mode (clamp ceiling). */
  max: Exclude<ReasoningLevel, "default" | "auto">;
  /** Min iterations between agent override calls. */
  overrideCooldown: number;
  /**
   * Starting level for the auto policy before any iteration signals exist
   * (iteration 1 and quiet iterations). When unset it falls back to `min`
   * ("low" in `DEFAULTS`), so trivial Q&A turns no longer pay "medium"
   * reasoning; the policy still raises to high on hallucinations / audit
   * rejections / plan creation.
   */
  baseline?: Exclude<ReasoningLevel, "default" | "auto">;
}

export interface AppConfig {
  version: string;
  model: string;
  provider: ProviderConfig;
  orchestrator: OrchestratorConfig;
  moe: MoeConfig;
  experts: Record<string, ExpertConfig>;
  /**
   * Per-model capability overrides keyed by model id. Highest-priority source
   * in `resolveModelCapabilities` — wins over the live probe and the provider
   * preset. Lets a user pin vision/tools for a model the preset/probe get wrong.
   */
  modelCapabilities?: Record<string, ModelCapabilities>;
  tools: ToolsConfig;
  contextWindow: number;
  contextBudget: ContextBudget;
  instructions: InstructionsConfig;
  modelLoad: ModelLoadConfig;
  retry: RetryConfig;
  maxToolIterations: number;
  stuckThreshold: number;
  autoPlan: boolean;
  showReasoning: boolean;
  logLevel: string;
  locale: string;
  session: SessionConfig;
  contextLog: ContextLogConfig;
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
  hallucination?: HallucinationConfig;
  lsp?: LspConfig;
  updater: UpdaterConfig;
  reasoning?: ReasoningConfig;
}
