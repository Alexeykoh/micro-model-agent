// Чистые builders телеметрических записей session-журнала: компакция,
// контекст, usage и диагностика. Держат SessionLogger ≤300 (правило 6) и
// единый формат события (INV-13/INV-14/INV-15).
import type { SessionLogEntry } from "../modules/session/log-types";
import { moduleOf, type Diagnostic, type DiagnosticEvent } from "../output";
import type { PrefixDelta } from "./agent/prefix-monitor";
import type { CacheUsage } from "../llm/cache-usage";
import { redactContextSecrets } from "./agent/context-log";
import { compactionSummary } from "./compaction-summary";

type LogEntry = Omit<SessionLogEntry, "ts" | "source">;

/** Параметры `compaction`: причина, токены/качество до и после, стадия. */
export interface CompactionLogInfo {
  reason: string;
  iteration: number;
  tokensBefore?: number;
  tokensAfter?: number;
  qualityBefore?: number;
  qualityAfter?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  removedTurns?: number;
  keptTurns?: number;
  summary?: string;
  /** Насколько упал объём (токены). */
  reducedBy?: number;
  /** Стадия сокращения: summarize|prune-tools|aggressive|hard-drop. */
  strategy?: string;
}

/** Параметры `context`: бюджеты, токены, качество и состав блоков. */
export interface ContextLogInfo {
  kind: "start" | "iteration";
  iteration: number;
  provider?: string;
  model?: string;
  window?: number;
  systemBudget?: number;
  reserveBudget?: number;
  historyBudget?: number;
  systemTokens?: number;
  toolTokens?: number;
  tokens: number;
  /** Сырая оценка контекста (аддитивное диагностическое поле). */
  estimatedTokensRaw?: number;
  /** Калиброванная оценка контекста (аддитивное поле). */
  contextTokens?: number;
  /** Отношение actual/estimated калибратора. */
  calibrationRatio?: number;
  /** Состояние калибратора: cold|warming|trusted|stale. */
  calibrationState?: string;
  quality: number;
  messageCount: number;
  compactionCount: number;
  iterationsSinceCompaction: number;
  blocks?: Array<{
    label: string;
    priority: string;
    tokens: number;
    included: boolean;
  }>;
}

/** Параметры `llm_usage`: токены, источник, кеш, стабильность префикса. */
export interface LlmUsageLogInfo {
  provider?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "api" | "estimate";
  durationMs: number;
  /** Время декодирования (без префилла/TTFT), мс. */
  decodeMs?: number;
  /** Стабильность префикса промпта (client-side монитор кеша). */
  prefix?: PrefixDelta;
  /** Кеш-статистика вызова от провайдера. */
  cache?: CacheUsage;
  /** Кумулятивный прогресс хода (не стрик). */
  progress?: { totalBatches: number; novelTools: number; duplicateBatches: number };
}

/** `compaction`: сводка до/после в `content`. */
export function compactionEntry(info: CompactionLogInfo): LogEntry {
  return {
    type: "compaction",
    content: compactionSummary(info),
    iteration: info.iteration,
    reason: info.reason,
    tokensBefore: info.tokensBefore,
    tokensAfter: info.tokensAfter,
    qualityBefore: info.qualityBefore,
    qualityAfter: info.qualityAfter,
    messagesBefore: info.messagesBefore,
    messagesAfter: info.messagesAfter,
    removedTurns: info.removedTurns,
    keptTurns: info.keptTurns,
    summary: info.summary,
    reducedBy: info.reducedBy,
    strategy: info.strategy,
  };
}

/** `context`: снапшот бюджета/калибровки на старте и по итерациям. */
export function contextEntry(info: ContextLogInfo): LogEntry {
  return {
    type: "context",
    content:
      info.kind === "start"
        ? "context snapshot at session start"
        : `context at iteration ${info.iteration}`,
    iteration: info.iteration,
    provider: info.provider,
    model: info.model,
    window: info.window,
    systemBudget: info.systemBudget,
    reserveBudget: info.reserveBudget,
    historyBudget: info.historyBudget,
    systemTokens: info.systemTokens,
    toolTokens: info.toolTokens,
    estimatedTokensRaw: info.estimatedTokensRaw ?? info.tokens,
    contextTokens: info.contextTokens ?? info.tokens,
    calibrationRatio: info.calibrationRatio,
    calibrationState: info.calibrationState,
    quality: info.quality,
    messageCount: info.messageCount,
    compactionCount: info.compactionCount,
    iterationsSinceCompaction: info.iterationsSinceCompaction,
    blocks: info.blocks,
  };
}

/** `llm_usage`: токены/источник/кеш/стабильность префикса. */
export function llmUsageEntry(iteration: number, usage: LlmUsageLogInfo): LogEntry {
  return {
    type: "llm_usage",
    iteration,
    provider: usage.provider,
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    origin: usage.source,
    durationMs: usage.durationMs,
    decodeMs: usage.decodeMs,
    cacheStable: usage.prefix ? Number(usage.prefix.stableRatio.toFixed(4)) : undefined,
    cacheCause: usage.prefix?.cause,
    cachedTokens: usage.cache?.cachedTokens,
    cacheWriteTokens: usage.cache?.cacheWriteTokens,
    cacheSource: usage.cache?.source,
    progress: usage.progress,
  };
}

/**
 * `error`/fail-open диагностика: `content` = причина (совместимо со старыми
 * читателями лога), `source`/`module`/`operation`/`errorKind` — по INV-13/14.
 */
export function diagnosticEntry(
  type: "error" | DiagnosticEvent,
  diag: Diagnostic,
): Omit<SessionLogEntry, "ts" | "source"> {
  const cause = diag.cause ? redactContextSecrets(diag.cause) : undefined;
  return {
    type,
    content: cause ?? diag.operation,
    module: moduleOf(diag.source),
    operation: diag.operation,
    errorKind: diag.kind,
    cause,
    recoverable: diag.recoverable,
  };
}
