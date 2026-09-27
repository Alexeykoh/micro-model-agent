import type { AppConfig } from "./types";
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";
import { DEFAULT_SECURITY_CONFIG } from "./security";

type ReasoningBound = "low" | "medium" | "high";

const REASONING_BOUNDS = ["low", "medium", "high"] as const;

function bool(
  key: string,
  domain: string,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "bool", reconfigure, get, set };
}

function int(
  key: string,
  domain: string,
  min: number,
  max: number,
  step: number,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "int", min, max, step, reconfigure, get, set };
}

function share(
  key: string,
  domain: string,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "share", min: 0.05, max: 0.9, step: 0.01, reconfigure, get, set };
}

function enumOf(
  key: string,
  domain: string,
  values: readonly string[],
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "enum", enumValues: values, reconfigure, get, set };
}

export const EXTRA_DEFS: ConfigKeyDef[] = [
  bool("provider.fallback", "provider", false,
    (c) => c.provider.fallback ?? false,
    (c, v) => { c.provider.fallback = v as boolean; }),
  int("provider.maxCompletionTokens", "provider", 512, 128000, 1024, true,
    (c) => c.provider.maxCompletionTokens ?? 8192,
    (c, v) => { c.provider.maxCompletionTokens = v as number; }),

  share("contextBudget.compactionThreshold", "budget", false,
    (c) => c.contextBudget.compactionThreshold,
    (c, v) => { c.contextBudget.compactionThreshold = v as number; }),
  share("contextBudget.compactionMinLoad", "budget", false,
    (c) => c.contextBudget.compactionMinLoad ?? DEFAULTS.contextBudget.compactionMinLoad,
    (c, v) => { c.contextBudget.compactionMinLoad = v as number; }),
  bool("instructions.summarize", "budget", true,
    (c) => c.instructions?.summarize ?? DEFAULTS.instructions.summarize,
    (c, v) => {
      c.instructions ??= structuredClone(DEFAULTS.instructions);
      c.instructions.summarize = v as boolean;
    }),

  bool("contextLog.enabled", "budget", false,
    (c) => c.contextLog?.enabled ?? DEFAULTS.contextLog.enabled,
    (c, v) => {
      c.contextLog ??= structuredClone(DEFAULTS.contextLog);
      c.contextLog.enabled = v as boolean;
    }),
  bool("contextLog.redact", "budget", false,
    (c) => c.contextLog?.redact ?? DEFAULTS.contextLog.redact,
    (c, v) => {
      c.contextLog ??= structuredClone(DEFAULTS.contextLog);
      c.contextLog.redact = v as boolean;
    }),

  enumOf("reasoning.min", "reasoning", REASONING_BOUNDS, true,
    (c) => c.reasoning?.min ?? DEFAULTS.reasoning!.min,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.min = v as ReasoningBound;
    }),
  enumOf("reasoning.max", "reasoning", REASONING_BOUNDS, true,
    (c) => c.reasoning?.max ?? DEFAULTS.reasoning!.max,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.max = v as ReasoningBound;
    }),
  enumOf("reasoning.baseline", "reasoning", REASONING_BOUNDS, true,
    (c) => c.reasoning?.baseline ?? DEFAULTS.reasoning!.baseline,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.baseline = v as ReasoningBound;
    }),
  int("reasoning.overrideCooldown", "reasoning", 1, 60, 1, true,
    (c) => c.reasoning?.overrideCooldown ?? DEFAULTS.reasoning!.overrideCooldown,
    (c, v) => {
      c.reasoning ??= structuredClone(DEFAULTS.reasoning!);
      c.reasoning.overrideCooldown = v as number;
    }),

  bool("autoPlan", "agent", true,
    (c) => c.autoPlan,
    (c, v) => { c.autoPlan = v as boolean; }),
  bool("tools.enableOnDemand", "agent", true,
    (c) => c.tools.enableOnDemand,
    (c, v) => { c.tools.enableOnDemand = v as boolean; }),

  bool("session.autoSave", "session", false,
    (c) => c.session?.autoSave ?? DEFAULTS.session.autoSave,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.autoSave = v as boolean;
    }),
  int("session.maxSessions", "session", 1, 500, 1, false,
    (c) => c.session?.maxSessions ?? DEFAULTS.session.maxSessions,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.maxSessions = v as number;
    }),
  bool("session.isolateMemory", "session", false,
    (c) => c.session?.isolateMemory ?? DEFAULTS.session.isolateMemory,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.isolateMemory = v as boolean;
    }),
  bool("session.autoName", "session", false,
    (c) => c.session?.autoName ?? DEFAULTS.session.autoName,
    (c, v) => {
      c.session ??= structuredClone(DEFAULTS.session);
      c.session.autoName = v as boolean;
    }),

  bool("sessionIsolation.enabled", "session", false,
    (c) => c.sessionIsolation?.enabled ?? DEFAULTS.sessionIsolation!.enabled,
    (c, v) => {
      c.sessionIsolation ??= structuredClone(DEFAULTS.sessionIsolation!);
      c.sessionIsolation.enabled = v as boolean;
    }),
  bool("sessionIsolation.isolatePlugins", "session", false,
    (c) => c.sessionIsolation?.isolatePlugins ?? DEFAULTS.sessionIsolation!.isolatePlugins,
    (c, v) => {
      c.sessionIsolation ??= structuredClone(DEFAULTS.sessionIsolation!);
      c.sessionIsolation.isolatePlugins = v as boolean;
    }),
  bool("sessionIsolation.isolateTempFiles", "session", false,
    (c) => c.sessionIsolation?.isolateTempFiles ?? DEFAULTS.sessionIsolation!.isolateTempFiles,
    (c, v) => {
      c.sessionIsolation ??= structuredClone(DEFAULTS.sessionIsolation!);
      c.sessionIsolation.isolateTempFiles = v as boolean;
    }),

  bool("ui.spinner", "ui", false,
    (c) => c.ui.spinner,
    (c, v) => { c.ui.spinner = v as boolean; }),
  bool("ui.showContextStats", "ui", false,
    (c) => c.ui.showContextStats,
    (c, v) => { c.ui.showContextStats = v as boolean; }),
  bool("ui.showCompaction", "ui", false,
    (c) => c.ui.showCompaction,
    (c, v) => { c.ui.showCompaction = v as boolean; }),

  int("retry.maxRetries", "agent", 0, 10, 1, false,
    (c) => c.retry.maxRetries,
    (c, v) => { c.retry.maxRetries = v as number; }),
  int("retry.baseDelay", "agent", 0, 60000, 100, false,
    (c) => c.retry.baseDelay,
    (c, v) => { c.retry.baseDelay = v as number; }),
  int("retry.maxDelay", "agent", 0, 300000, 1000, false,
    (c) => c.retry.maxDelay,
    (c, v) => { c.retry.maxDelay = v as number; }),
  int("retry.maxStreamRetries", "agent", 0, 10, 1, false,
    (c) => c.retry.maxStreamRetries ?? DEFAULTS.retry.maxStreamRetries,
    (c, v) => { c.retry.maxStreamRetries = v as number; }),
  int("retry.noDataTimeoutMs", "agent", 1000, 600000, 1000, false,
    (c) => c.retry.noDataTimeoutMs ?? DEFAULTS.retry.noDataTimeoutMs,
    (c, v) => { c.retry.noDataTimeoutMs = v as number; }),

  bool("pricing.enabled", "pricing", false,
    (c) => c.pricing?.enabled ?? DEFAULTS.pricing!.enabled,
    (c, v) => {
      c.pricing ??= structuredClone(DEFAULTS.pricing!);
      c.pricing.enabled = v as boolean;
    }),

  bool("updater.enabled", "updater", false,
    (c) => c.updater.enabled,
    (c, v) => { c.updater.enabled = v as boolean; }),
  bool("updater.checkOnStart", "updater", false,
    (c) => c.updater.checkOnStart,
    (c, v) => { c.updater.checkOnStart = v as boolean; }),
  bool("updater.autoInstall", "updater", false,
    (c) => c.updater.autoInstall,
    (c, v) => { c.updater.autoInstall = v as boolean; }),
  int("updater.intervalMs", "updater", 0, 86400000, 60000, false,
    (c) => c.updater.intervalMs,
    (c, v) => { c.updater.intervalMs = v as number; }),

  share("skills.budget", "agent", false,
    (c) => c.skills.budget,
    (c, v) => { c.skills.budget = v as number; }),

  bool("hallucination.judge.enabled", "agent", true,
    (c) => c.hallucination?.judge.enabled ?? DEFAULTS.hallucination!.judge.enabled,
    (c, v) => {
      c.hallucination ??= structuredClone(DEFAULTS.hallucination!);
      c.hallucination.judge.enabled = v as boolean;
    }),

  enumOf("subagent.resultMode", "agent", ["text", "file"] as const, true,
    (c) => c.subagent?.resultMode ?? DEFAULTS.subagent.resultMode,
    (c, v) => {
      c.subagent ??= structuredClone(DEFAULTS.subagent);
      c.subagent.resultMode = v as "text" | "file";
    }),
  int("subagent.maxSummaryChars", "agent", 100, 50000, 100, false,
    (c) => c.subagent?.maxSummaryChars ?? DEFAULTS.subagent.maxSummaryChars,
    (c, v) => {
      c.subagent ??= structuredClone(DEFAULTS.subagent);
      c.subagent.maxSummaryChars = v as number;
    }),
  int("subagent.maxParallelChunkQueries", "agent", 1, 16, 1, false,
    (c) => c.subagent?.maxParallelChunkQueries ?? DEFAULTS.subagent.maxParallelChunkQueries,
    (c, v) => {
      c.subagent ??= structuredClone(DEFAULTS.subagent);
      c.subagent.maxParallelChunkQueries = v as number;
    }),
  bool("subagent.stableSystemPrompt", "agent", false,
    (c) => c.subagent?.stableSystemPrompt ?? DEFAULTS.subagent.stableSystemPrompt,
    (c, v) => {
      c.subagent ??= structuredClone(DEFAULTS.subagent);
      c.subagent.stableSystemPrompt = v as boolean;
    }),

  bool("modelLoad.autoLoad", "provider", true,
    (c) => c.modelLoad?.autoLoad ?? DEFAULTS.modelLoad.autoLoad,
    (c, v) => {
      c.modelLoad ??= structuredClone(DEFAULTS.modelLoad);
      c.modelLoad.autoLoad = v as boolean;
    }),
  bool("modelLoad.flashAttention", "provider", true,
    (c) => c.modelLoad?.flashAttention ?? DEFAULTS.modelLoad.flashAttention,
    (c, v) => {
      c.modelLoad ??= structuredClone(DEFAULTS.modelLoad);
      c.modelLoad.flashAttention = v as boolean;
    }),
  bool("modelLoad.offloadKvCacheToGpu", "provider", true,
    (c) => c.modelLoad?.offloadKvCacheToGpu ?? DEFAULTS.modelLoad.offloadKvCacheToGpu,
    (c, v) => {
      c.modelLoad ??= structuredClone(DEFAULTS.modelLoad);
      c.modelLoad.offloadKvCacheToGpu = v as boolean;
    }),
  // No schema default (omitted unless set); 512 mirrors the llama.cpp default.
  int("modelLoad.evalBatchSize", "provider", 1, 4096, 1, true,
    (c) => c.modelLoad?.evalBatchSize ?? 512,
    (c, v) => {
      c.modelLoad ??= structuredClone(DEFAULTS.modelLoad);
      c.modelLoad.evalBatchSize = v as number;
    }),

  bool("webSearch.enabled", "research", false,
    (c) => c.webSearch?.enabled ?? DEFAULTS.webSearch!.enabled,
    (c, v) => {
      c.webSearch ??= structuredClone(DEFAULTS.webSearch!);
      c.webSearch.enabled = v as boolean;
    }),

  bool("errorWebSearch.enabled", "research", false,
    (c) => c.errorWebSearch?.enabled ?? DEFAULTS.errorWebSearch!.enabled,
    (c, v) => {
      c.errorWebSearch ??= structuredClone(DEFAULTS.errorWebSearch!);
      c.errorWebSearch.enabled = v as boolean;
    }),
  int("errorWebSearch.threshold", "research", 1, 20, 1, false,
    (c) => c.errorWebSearch?.threshold ?? DEFAULTS.errorWebSearch!.threshold,
    (c, v) => {
      c.errorWebSearch ??= structuredClone(DEFAULTS.errorWebSearch!);
      c.errorWebSearch.threshold = v as number;
    }),
  int("errorWebSearch.maxResults", "research", 1, 20, 1, false,
    (c) => c.errorWebSearch?.maxResults ?? DEFAULTS.errorWebSearch!.maxResults,
    (c, v) => {
      c.errorWebSearch ??= structuredClone(DEFAULTS.errorWebSearch!);
      c.errorWebSearch.maxResults = v as number;
    }),
  int("errorWebSearch.maxQueryChars", "research", 50, 2000, 10, false,
    (c) => c.errorWebSearch?.maxQueryChars ?? DEFAULTS.errorWebSearch!.maxQueryChars,
    (c, v) => {
      c.errorWebSearch ??= structuredClone(DEFAULTS.errorWebSearch!);
      c.errorWebSearch.maxQueryChars = v as number;
    }),
  int("errorWebSearch.maxSearchesPerSession", "research", 0, 20, 1, false,
    (c) => c.errorWebSearch?.maxSearchesPerSession ?? DEFAULTS.errorWebSearch!.maxSearchesPerSession,
    (c, v) => {
      c.errorWebSearch ??= structuredClone(DEFAULTS.errorWebSearch!);
      c.errorWebSearch.maxSearchesPerSession = v as number;
    }),
  int("errorWebSearch.requestTimeoutMs", "research", 1000, 120000, 1000, false,
    (c) => c.errorWebSearch?.requestTimeoutMs ?? DEFAULTS.errorWebSearch!.requestTimeoutMs,
    (c, v) => {
      c.errorWebSearch ??= structuredClone(DEFAULTS.errorWebSearch!);
      c.errorWebSearch.requestTimeoutMs = v as number;
    }),

  bool("browser.enabled", "browser", false,
    (c) => c.browser.enabled,
    (c, v) => { c.browser.enabled = v as boolean; }),
  bool("browser.headless", "browser", false,
    (c) => c.browser.headless,
    (c, v) => { c.browser.headless = v as boolean; }),
  int("browser.maxElements", "browser", 1, 200, 1, false,
    (c) => c.browser.maxElements,
    (c, v) => { c.browser.maxElements = v as number; }),
  int("browser.maxContentChars", "browser", 100, 50000, 100, false,
    (c) => c.browser.maxContentChars,
    (c, v) => { c.browser.maxContentChars = v as number; }),
  int("browser.maxConsoleEntries", "browser", 1, 200, 1, false,
    (c) => c.browser.maxConsoleEntries,
    (c, v) => { c.browser.maxConsoleEntries = v as number; }),
  int("browser.maxConsoleLineChars", "browser", 50, 5000, 10, false,
    (c) => c.browser.maxConsoleLineChars,
    (c, v) => { c.browser.maxConsoleLineChars = v as number; }),
  int("browser.viewportWidth", "browser", 320, 4096, 10, false,
    (c) => c.browser.viewportWidth,
    (c, v) => { c.browser.viewportWidth = v as number; }),
  int("browser.viewportHeight", "browser", 200, 2160, 10, false,
    (c) => c.browser.viewportHeight,
    (c, v) => { c.browser.viewportHeight = v as number; }),
  int("browser.navigationTimeout", "browser", 1000, 120000, 1000, false,
    (c) => c.browser.navigationTimeout,
    (c, v) => { c.browser.navigationTimeout = v as number; }),

  int("security.maxRecursionDepth", "security", 0, 20, 1, false,
    (c) => c.security?.maxRecursionDepth ?? DEFAULT_SECURITY_CONFIG.maxRecursionDepth,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.maxRecursionDepth = v as number;
    }),
  int("security.maxFileOperations", "security", 0, 10000, 10, false,
    (c) => c.security?.maxFileOperations ?? DEFAULT_SECURITY_CONFIG.maxFileOperations,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.maxFileOperations = v as number;
    }),
  int("security.rateLimits.maxRequestsPerMinute", "security", 1, 1000, 1, false,
    (c) => c.security?.rateLimits.maxRequestsPerMinute ?? DEFAULT_SECURITY_CONFIG.rateLimits.maxRequestsPerMinute,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.rateLimits.maxRequestsPerMinute = v as number;
    }),
  int("security.rateLimits.maxParallelTasks", "security", 1, 50, 1, false,
    (c) => c.security?.rateLimits.maxParallelTasks ?? DEFAULT_SECURITY_CONFIG.rateLimits.maxParallelTasks,
    (c, v) => {
      c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
      c.security.rateLimits.maxParallelTasks = v as number;
    }),
];
