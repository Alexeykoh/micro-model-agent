/**
 * Адаптивные стадии компакции: summarize → prune tool results → aggressive
 * keepLastN → hard drop. Вынесено из `manager-compaction.ts` (правило 6);
 * порядок стадий, порог значимости и счётчики те же.
 */
import { absorbLedgers } from "./ledger-absorb";
import type { Message } from "./message";
import { KEEP_LAST_N, type CompactOptions, type CompactResult } from "./manager-types";
import type { ContextState } from "./manager-state";
import { estimatedTokens, invalidateEstimate } from "./manager-estimate";
import { qualityScore } from "./manager-quality";
import { stampSeq } from "./manager-history";
import { buildCompactionBlock } from "./manager-compaction-block";
import { compact, pruneStaleToolResults } from "./manager-compaction";

/**
 * v2-компакция с гарантией прогресса: summarize → prune tool results →
 * aggressive keepLastN → hard drop. Возвращает результат первой стадии,
 * давшей значимое сокращение; иначе последний (hard-drop).
 */
export function compactAdaptive(s: ContextState, opts?: CompactOptions): CompactResult | null {
  const { minReduction, keepLastN, toolResultKeep } = resolveCompactOptions(s, opts);
  // Исходный объём — база для ОБЩЕГО прогресса. Стадии сжимают историю
  // последовательно, поэтому reducedBy отдельной стадии занижен; клиент
  // (CompactionService) должен видеть суммарное сокращение от исходного.
  const originalTokens = estimatedTokens(s);

  let result = finalizeAdaptive(s, compact(s, { keepLastN, minReduction }), originalTokens);
  if (isReduced(result, minReduction)) return result;

  result = finalizeAdaptive(
    s,
    escalatePrune(s, result, keepLastN, toolResultKeep, minReduction),
    originalTokens,
  );
  if (isReduced(result, minReduction)) return result;

  result = finalizeAdaptive(
    s,
    escalateAggressive(s, result, keepLastN, minReduction),
    originalTokens,
  );
  if (isReduced(result, minReduction)) return result;

  const smaller = Math.max(2, Math.floor(keepLastN / 2));
  return finalizeAdaptive(s, hardDropOldest(s, smaller) ?? result, originalTokens);
}

/** Пересчитывает токены результата как ОБЩЕЕ сокращение от исходного объёма. */
function finalizeAdaptive(
  s: ContextState,
  result: CompactResult | null,
  originalTokens: number,
): CompactResult | null {
  if (!result) return null;
  const tokensAfter = estimatedTokens(s);
  return {
    ...result,
    tokensBefore: originalTokens,
    tokensAfter,
    reducedBy: originalTokens - tokensAfter,
  };
}

/** Резолвит опции компакции с дефолтами менеджера. */
function resolveCompactOptions(
  s: ContextState,
  opts?: CompactOptions,
): { minReduction: number; keepLastN: number; toolResultKeep: number } {
  return {
    minReduction: opts?.minReduction ?? 0,
    keepLastN: opts?.keepLastN ?? KEEP_LAST_N,
    toolResultKeep: opts?.toolResultKeep ?? s.toolResultKeep,
  };
}

/** True, если результат дал значимое сокращение. */
function isReduced(result: CompactResult | null, minReduction: number): boolean {
  return result !== null && result.reducedBy > minReduction;
}

/** Стадия A: чистка старых tool-результатов + повторная суммаризация. */
function escalatePrune(
  s: ContextState,
  prev: CompactResult | null,
  keepLastN: number,
  toolResultKeep: number,
  minReduction: number,
): CompactResult | null {
  if (pruneStaleToolResults(s, toolResultKeep, keepLastN) <= 0) return prev;
  const pruned = compact(s, { keepLastN, minReduction });
  return pruned ? { ...pruned, strategy: "prune-tools" } : prev;
}

/** Стадия B: агрессивнее оставляем свежих сообщений. */
function escalateAggressive(
  s: ContextState,
  prev: CompactResult | null,
  keepLastN: number,
  minReduction: number,
): CompactResult | null {
  const smaller = Math.max(2, Math.floor(keepLastN / 2));
  if (smaller >= keepLastN) return prev;
  const aggressive = compact(s, { keepLastN: smaller, minReduction });
  return aggressive ? { ...aggressive, strategy: "aggressive" } : prev;
}

/**
 * Stage C: жёсткий дроп старейших групп сверх `keep` (system и активный
 * system-summary сохраняются). Пишет диагностику вызывающему.
 */
export function hardDropOldest(s: ContextState, keep: number): CompactResult | null {
  const firstSystem = s.messages.find((m) => m.role === "system");
  const nonSystem = s.messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= keep) return null;
  const tokensBefore = estimatedTokens(s);
  const qualityBefore = qualityScore(s);
  const messagesBefore = s.messages.length;
  const head = nonSystem.slice(0, Math.max(0, nonSystem.length - keep * 2));
  const tail = nonSystem.slice(Math.max(0, nonSystem.length - keep * 2));
  s.facts.extract(head);
  absorbLedgers(
    head,
    s.ledger,
    s.compactionSummaryMode !== "off",
    s.toolLedger,
    s.toolLedgerKeys,
  );
  // Сводка hard-drop строится из СВЕЖИХ фактов выброшенного head, а не из
  // остатка предыдущей компакции: иначе свежие `[Files:]`/`[Errors:]` попадали
  // в сообщение только при СЛЕДУЮЩЕЙ компакции (§3.6 аудита).
  const headBlock = buildCompactionBlock(s, head);
  const summary: Message = stampSeq(s, {
    role: "user",
    content: `<system-summary>[Compressed: ${head.length} old turns hard-dropped to fit context] ${headBlock}</system-summary>`,
  });
  // T4: hard-drop тоже производен от выброшенного ввода.
  if (head.some((m) => s.book.isTainted(m))) s.book.markTainted(summary);
  s.messages = [...(firstSystem ? [firstSystem] : []), summary, ...tail];
  s.iterationsSinceCompaction = 0;
  invalidateEstimate(s);
  s.compactionCount++;
  // INV-15: hard-drop тоже поглотил адреса — учитываем прогресс.
  s.compactionProgress.note(s.ledger?.totalRecorded() ?? 0);
  const tokensAfter = estimatedTokens(s);
  if (s.onCompact) s.onCompact(summary);
  return {
    removedTurns: head.length,
    keptTurns: tail.length,
    tokensBefore,
    tokensAfter,
    qualityBefore,
    qualityAfter: qualityScore(s),
    messagesBefore,
    messagesAfter: s.messages.length,
    summary: headBlock,
    reducedBy: tokensBefore - tokensAfter,
    strategy: "hard-drop",
  };
}
