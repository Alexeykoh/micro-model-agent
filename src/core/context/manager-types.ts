/**
 * Формы данных менеджера контекста. Вынесены из `manager.ts` (правило 6):
 * публичный API (`ContextManager` и его типы) реэкспортируется из `manager.ts`,
 * здесь — только объявления, чтобы швы (`manager-state`, `manager-estimate`,
 * `manager-compaction`, `manager-history`) не тянули друг друга через класс.
 */
import type { CalibrationState } from "../../core/api";
import type { ContextBreakdown, ContextQualityBreakdown } from "../../core/types";

/** Бюджет контекста в токенах: системный промпт, резерв ответа, история. */
export interface ContextBudget {
  systemPrompt: number;
  responseReserve: number;
  history: number;
}

export const COMPACTION_INTERVAL = 15;
export const KEEP_LAST_N = 6;

/** Результат компакции: счётчики ходов/токенов/качества + внутренняя сводка. */
export interface CompactResult {
  /** Ходов удалено компакцией (oldTurns). */
  removedTurns: number;
  /** Ходов оставлено дословно (свежие, минус протухшие <system-summary>). */
  keptTurns: number;
  tokensBefore: number;
  tokensAfter: number;
  qualityBefore: number;
  qualityAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** Внутренний блок [Compressed: ...] (без обёртки <system-summary>). */
  summary: string;
  /** Насколько упал объём в токенах (tokensBefore − tokensAfter). */
  reducedBy: number;
  /** Стадия, давшая сокращение: summarize|prune-tools|aggressive|hard-drop. */
  strategy: string;
}

/** Опции компакции (v2). */
export interface CompactOptions {
  /** Сколько свежих сообщений оставить дословно (по умолчанию KEEP_LAST_N). */
  keepLastN?: number;
  /** Сколько последних tool-результатов не чистить при prune-tools. */
  toolResultKeep?: number;
  /** Порог значимости: ниже него счётчик/лог не обновляются. */
  minReduction?: number;
}

/** Снапшот состояния контекста для логов/наблюдаемости. */
export interface ContextSnapshot {
  window: number;
  budget: ContextBudget;
  /** Оценка токенов в истории (сообщения + определения тулов). */
  tokens: number;
  toolTokens: number;
  messageCount: number;
  quality: number;
  compactionCount: number;
  iterationsSinceCompaction: number;
  /** Разбор оценки качества (составляющие + веса). */
  qualityBreakdown: ContextQualityBreakdown;
  /** Разбивка контекста по частям (сегменты полосы в UI). */
  breakdown: ContextBreakdown;
  /** Сырая оценка (сообщения + тулы) без калибровки. */
  estimatedTokensRaw: number;
  /** Калиброванная оценка — вход для порогов компакции. */
  contextTokens: number;
  /** Текущее отношение actual/estimated калибратора. */
  calibrationRatio: number;
  /** Состояние калибратора. */
  calibrationState: CalibrationState;
}

/** Диагностика оценки контекста (аддитивные поля лога/снимка). */
export interface ContextEstimateDiagnostics {
  raw: number;
  calibrated: number;
  ratio: number;
  state: CalibrationState;
}
