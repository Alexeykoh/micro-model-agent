// Доп. дефы реестра (~110 ключей): фабрики bool/int/share/enum/list/str/json + EXTRA_DEFS.
import type { AppConfig, AuditEventType } from "./types";
import type { ConfigKeyDef, ConfigRangeReason } from "./registry";
import { DEFAULTS } from "./defaults";
import { DEFAULT_SECURITY_CONFIG } from "./security";

type ReasoningBound = "low" | "medium" | "high";

const REASONING_BOUNDS = ["low", "medium", "high"] as const;

/** Фабрика bool-дефа. */
function bool(
  key: string,
  domain: string,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "bool", reconfigure, get, set };
}

/** Фабрика int-дефа с min/max/step. */
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

/** Фабрика share-дефа (доля 0.05–0.9). */
function share(
  key: string,
  domain: string,
  reconfigure: boolean,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "share", min: 0.05, max: 0.9, step: 0.01, reconfigure, get, set };
}

/** Фабрика enum-дефа. */
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

/** Фабрика list-дефа (без reconfigure, опц. редактор). */
function list(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
  editor?: ConfigKeyDef["editor"],
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "list", reconfigure: false, editor, get, set };
}

/** Фабрика string-дефа. */
function str(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return { key, aliases: [], domain, valueType: "string", reconfigure: false, get, set };
}

/** Опциональная строка: get отдаёт "" при неустановленной, set чистит в undefined на пустой. */
function strOpt(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
): ConfigKeyDef {
  return str(key, domain, get, set);
}

/** Фабрика json-дефа с опц. валидацией и редактором. */
function json(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
  extraValidate?: ConfigKeyDef["extraValidate"],
  editor?: ConfigKeyDef["editor"],
): ConfigKeyDef {
  return {
    key,
    aliases: [],
    domain,
    valueType: "json",
    reconfigure: false,
    editor,
    get,
    set,
    extraValidate,
  };
}

/** JSON-деф с предикатом формы; всё, не прошедшее проверку, — "invalid". */
function jsonShape(
  key: string,
  domain: string,
  get: (c: AppConfig) => unknown,
  set: (c: AppConfig, v: unknown) => void,
  check: (v: unknown) => boolean,
  editor?: ConfigKeyDef["editor"],
): ConfigKeyDef {
  const extraValidate = (_c: AppConfig, v: unknown): ConfigRangeReason | "invalid" | null =>
    check(v) ? null : "invalid";
  return json(key, domain, get, set, extraValidate, editor);
}

/** Лениво создаёт опциональное гнездо security и возвращает его. */
function sec(c: AppConfig) {
  c.security ??= structuredClone(DEFAULT_SECURITY_CONFIG);
  return c.security;
}

/** Проверка на запись (объект-не-массив). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Проверка на неотрицательное число. */
function isNonNegNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

const AUDIT_EVENT_TYPES: readonly AuditEventType[] = [
  "security_block",
  "bash_command",
  "file_operation",
  "network_request",
  "tool_call",
  "authentication",
  "configuration_change",
  "session_start",
  "session_end",
];

/** Доп. дефы реестра; мержится в DEFINITIONS конкатом (см. registry.ts). */
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
  enumOf("ui.activityRail", "ui", ["off", "line", "meta", "full"] as const, false,
    (c) => c.ui.activityRail ?? "line",
    (c, v) => { c.ui.activityRail = v as "off" | "line" | "meta" | "full"; }),
  bool("ui.showContextStats", "ui", false,
    (c) => c.ui.showContextStats,
    (c, v) => { c.ui.showContextStats = v as boolean; }),
  bool("ui.showCompaction", "ui", false,
    (c) => c.ui.showCompaction,
    (c, v) => { c.ui.showCompaction = v as boolean; }),
  enumOf("ui.fontSize", "ui", ["compact", "comfortable", "large"] as const, false,
    (c) => c.ui.fontSize ?? "comfortable",
    (c, v) => { c.ui.fontSize = v as "compact" | "comfortable" | "large"; }),

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
  // Дефолта в схеме нет (поле опускается, пока не задано); 512 зеркалит дефолт llama.cpp.
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

  list("tools.defaultTags", "tools",
    (c) => c.tools.defaultTags,
    (c, v) => { c.tools.defaultTags = v as string[]; },
    { kind: "tags", placeholder: "file" }),

  list("security.bash.blacklist", "security",
    (c) => c.security?.bash.blacklist ?? DEFAULT_SECURITY_CONFIG.bash.blacklist,
    (c, v) => { sec(c).bash.blacklist = v as string[]; },
    { kind: "tags", placeholder: "rm" }),
  list("security.bash.whitelist", "security",
    (c) => c.security?.bash.whitelist ?? DEFAULT_SECURITY_CONFIG.bash.whitelist,
    (c, v) => { sec(c).bash.whitelist = v as string[]; },
    { kind: "tags", placeholder: "bun" }),
  list("security.bash.dangerousFlags", "security",
    (c) => c.security?.bash.dangerousFlags ?? DEFAULT_SECURITY_CONFIG.bash.dangerousFlags,
    (c, v) => { sec(c).bash.dangerousFlags = v as string[]; },
    { kind: "tags", placeholder: "--force" }),
  list("security.bash.dangerousOperators", "security",
    (c) => c.security?.bash.dangerousOperators ?? DEFAULT_SECURITY_CONFIG.bash.dangerousOperators,
    (c, v) => { sec(c).bash.dangerousOperators = v as string[]; },
    { kind: "tags", placeholder: "&&" }),
  list("security.paths.denied", "security",
    (c) => c.security?.paths.denied ?? DEFAULT_SECURITY_CONFIG.paths.denied,
    (c, v) => { sec(c).paths.denied = v as string[]; },
    { kind: "tags", placeholder: ".git/" }),
  list("security.paths.allowed", "security",
    (c) => c.security?.paths.allowed ?? DEFAULT_SECURITY_CONFIG.paths.allowed,
    (c, v) => { sec(c).paths.allowed = v as string[]; },
    { kind: "tags", placeholder: "src/**" }),
  list("security.network.deniedDomains", "security",
    (c) => c.security?.network.deniedDomains ?? DEFAULT_SECURITY_CONFIG.network.deniedDomains,
    (c, v) => { sec(c).network.deniedDomains = v as string[]; },
    { kind: "tags", placeholder: "localhost" }),
  list("security.network.allowedDomains", "security",
    (c) => c.security?.network.allowedDomains ?? DEFAULT_SECURITY_CONFIG.network.allowedDomains,
    (c, v) => { sec(c).network.allowedDomains = v as string[]; },
    { kind: "tags", placeholder: "api.example.com" }),

  int("security.network.requestTimeout", "security", 1000, 120000, 1000, false,
    (c) => c.security?.network.requestTimeout ?? DEFAULT_SECURITY_CONFIG.network.requestTimeout,
    (c, v) => { sec(c).network.requestTimeout = v as number; }),
  int("security.network.maxResponseSize", "security", 1024, 1000000, 1024, false,
    (c) => c.security?.network.maxResponseSize ?? DEFAULT_SECURITY_CONFIG.network.maxResponseSize,
    (c, v) => { sec(c).network.maxResponseSize = v as number; }),

  jsonShape("security.contentScan.dangerousPatterns", "security",
    (c) => (c.security?.contentScan.dangerousPatterns ?? DEFAULT_SECURITY_CONFIG.contentScan.dangerousPatterns)
      .map((r) => r.source),
    (c, v) => { sec(c).contentScan.dangerousPatterns = (v as string[]).map((s) => new RegExp(s)); },
    (v) => Array.isArray(v) && v.every((s) => {
      if (typeof s !== "string") return false;
      try { new RegExp(s); return true; } catch { return false; }
    }),
    { kind: "tags", placeholder: "eval\\(" }),

  bool("security.auditNotifier.enabled", "security", false,
    (c) => c.security?.auditNotifier.enabled ?? DEFAULT_SECURITY_CONFIG.auditNotifier.enabled,
    (c, v) => { sec(c).auditNotifier.enabled = v as boolean; }),
  strOpt("security.auditNotifier.filePath", "security",
    (c) => c.security?.auditNotifier.filePath ?? "",
    (c, v) => {
      const s = String(v).trim();
      sec(c).auditNotifier.filePath = s.length === 0 ? undefined : s;
    }),
  strOpt("security.auditNotifier.webhookUrl", "security",
    (c) => c.security?.auditNotifier.webhookUrl ?? "",
    (c, v) => {
      const s = String(v).trim();
      sec(c).auditNotifier.webhookUrl = s.length === 0 ? undefined : s;
    }),
  int("security.auditNotifier.webhookTimeout", "security", 1000, 60000, 1000, false,
    (c) => c.security?.auditNotifier.webhookTimeout ?? DEFAULT_SECURITY_CONFIG.auditNotifier.webhookTimeout,
    (c, v) => { sec(c).auditNotifier.webhookTimeout = v as number; }),
  enumOf("security.auditNotifier.minSeverity", "security",
    ["low", "medium", "high", "critical"] as const, false,
    (c) => c.security?.auditNotifier.minSeverity ?? DEFAULT_SECURITY_CONFIG.auditNotifier.minSeverity,
    (c, v) => { sec(c).auditNotifier.minSeverity = v as "low" | "medium" | "high" | "critical"; }),
  jsonShape("security.auditNotifier.eventTypes", "security",
    (c) => c.security?.auditNotifier.eventTypes ?? DEFAULT_SECURITY_CONFIG.auditNotifier.eventTypes,
    (c, v) => { sec(c).auditNotifier.eventTypes = v as AuditEventType[]; },
    (v) => Array.isArray(v) && v.every((e) =>
      typeof e === "string" && (AUDIT_EVENT_TYPES as readonly string[]).includes(e)),
    // Пустой массив = все типы событий (см. описание ключа).
    { kind: "checkboxes", options: AUDIT_EVENT_TYPES }),
  int("security.auditNotifier.maxRetries", "security", 0, 10, 1, false,
    (c) => c.security?.auditNotifier.maxRetries ?? DEFAULT_SECURITY_CONFIG.auditNotifier.maxRetries,
    (c, v) => { sec(c).auditNotifier.maxRetries = v as number; }),

  strOpt("security.sessionEncryption.keyPath", "security",
    (c) => c.security?.sessionEncryption.keyPath ?? "",
    (c, v) => {
      const s = String(v).trim();
      sec(c).sessionEncryption.keyPath = s.length === 0 ? undefined : s;
    }),
  bool("security.sessionEncryption.encryptHistory", "security", false,
    (c) => c.security?.sessionEncryption.encryptHistory ?? DEFAULT_SECURITY_CONFIG.sessionEncryption.encryptHistory,
    (c, v) => { sec(c).sessionEncryption.encryptHistory = v as boolean; }),
  bool("security.sessionEncryption.encryptSessionLog", "security", false,
    (c) => c.security?.sessionEncryption.encryptSessionLog ?? DEFAULT_SECURITY_CONFIG.sessionEncryption.encryptSessionLog,
    (c, v) => { sec(c).sessionEncryption.encryptSessionLog = v as boolean; }),

  jsonShape("pricing.overrides", "pricing",
    (c) => c.pricing?.overrides ?? {},
    (c, v) => {
      c.pricing ??= structuredClone(DEFAULTS.pricing!);
      c.pricing.overrides = v as Record<string, { input: number; output: number }>;
    },
    (v) => isRecord(v) && Object.values(v).every((e) =>
      isRecord(e) &&
      isNonNegNum(e.input) &&
      isNonNegNum(e.output) &&
      (e.cachedInput === undefined || isNonNegNum(e.cachedInput)) &&
      (e.cacheWrite === undefined || isNonNegNum(e.cacheWrite))),
    {
      kind: "table",
      columns: [
        { key: "name" },
        { key: "input", type: "number" },
        { key: "output", type: "number" },
        { key: "cachedInput", type: "number", optional: true },
        { key: "cacheWrite", type: "number", optional: true },
      ],
    }),

  jsonShape("modelCapabilities", "provider",
    (c) => c.modelCapabilities ?? {},
    (c, v) => { c.modelCapabilities = v as AppConfig["modelCapabilities"]; },
    (v) => isRecord(v) && Object.values(v).every((e) =>
      isRecord(e) &&
      (e.vision === undefined || typeof e.vision === "boolean") &&
      (e.tools === undefined || typeof e.tools === "boolean")),
    {
      kind: "table",
      columns: [
        { key: "name" },
        { key: "vision", type: "bool", optional: true },
        { key: "tools", type: "bool", optional: true },
      ],
    }),

  jsonShape("experts", "agent",
    (c) => c.experts,
    (c, v) => { c.experts = v as AppConfig["experts"]; },
    (v) => isRecord(v) && Object.values(v).every((e) =>
      isRecord(e) &&
      typeof e.model === "string" &&
      Array.isArray(e.tool_tags) &&
      e.tool_tags.every((t) => typeof t === "string") &&
      (e.max_attempts === undefined || (typeof e.max_attempts === "number" && Number.isFinite(e.max_attempts))) &&
      (e.description === undefined || typeof e.description === "string")),
    {
      kind: "table",
      columns: [
        { key: "name" },
        { key: "model" },
        { key: "tool_tags", array: true },
        { key: "max_attempts", type: "number", optional: true },
        { key: "description", optional: true },
      ],
    }),
];
