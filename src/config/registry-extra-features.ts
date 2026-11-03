// Дефы суб-агента, загрузки модели, веб-поиска (в т.ч. error-поиска) и
// браузера. Вынесены из `registry-extra.ts` (правило 6); порядок внутри
// группы — порядок `EXTRA_DEFS`.
import type { ConfigKeyDef } from "./registry";
import { DEFAULTS } from "./defaults";
import { bool, enumOf, int } from "./registry-extra-factories";

export const FEATURE_DEFS: ConfigKeyDef[] = [
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
  int("subagent.timeoutMs", "agent", 10000, 1800000, 1000, false,
    (c) => c.subagent?.timeoutMs ?? DEFAULTS.subagent.timeoutMs,
    (c, v) => {
      c.subagent ??= structuredClone(DEFAULTS.subagent);
      c.subagent.timeoutMs = v as number;
    }),
  int("subagent.maxDurationMs", "agent", 60000, 7200000, 60000, false,
    (c) => c.subagent?.maxDurationMs ?? DEFAULTS.subagent.maxDurationMs,
    (c, v) => {
      c.subagent ??= structuredClone(DEFAULTS.subagent);
      c.subagent.maxDurationMs = v as number;
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
    (c) => c.browser.enabled, (c, v) => { c.browser.enabled = v as boolean; }),
  bool("browser.headless", "browser", false,
    (c) => c.browser.headless, (c, v) => { c.browser.headless = v as boolean; }),
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
];
