/**
 * Оценка качества контекста (0–100) и её разбор. Вынесено из `manager.ts`
 * (правило 6); формула, веса и кап штрафа за компакции не менялись.
 */
import type { ContextQualityBreakdown } from "../../core/types";
import { COMPACTION_INTERVAL } from "./manager-types";
import { historyTokensForThresholds } from "./manager-estimate";
import { computeQualityScore, QUALITY_WEIGHT, type QualityFactors } from "./quality";
import type { ContextState } from "./manager-state";

/**
 * Нормированные факторы качества (0..1, больше — лучше): нагрузка контекста,
 * сохраняемость после компакций, плотность ошибок и свежесть. Единственный
 * источник правды для числа и разбора.
 */
export function qualityFactors(s: ContextState): QualityFactors {
  const usedTokens = historyTokensForThresholds(s);
  const load = s.budget.history > 0 ? Math.max(0, 1 - usedTokens / s.budget.history) : 0;

  // Восстанавливаемый штраф: каждая компакция теряет часть информации, но штраф
  // ОГРАНИЧЕН СВЕРХУ, чтобы кумулятивные компакции не прикалывали качество ниже
  // триггера форсированной компакции (40%). До капа сессия с ~7+ компакциями
  // клампила слагаемое в 0 навсегда; вместе с тяжёлой токенной нагрузкой и
  // плотностью ошибок качество застревало ниже 40 и компакция срабатывала на
  // КАЖДОЙ итерации (было: 56 компакций за 28 минут).
  const COMPACTION_PENALTY_FLOOR = 0.5;
  const compaction = Math.max(COMPACTION_PENALTY_FLOOR, 1 - s.compactionCount * 0.15);

  const msgCount = s.messages.length || 1;
  const errors = Math.max(0, 1 - Math.min(1, s.facts.errorCount / msgCount));

  const freshness = Math.max(0, 1 - s.iterationsSinceCompaction / COMPACTION_INTERVAL);

  return { load, compaction, errors, freshness };
}

/** Оценка качества контекста 0–100 (нагрузка, компакции, ошибки, свежесть). */
export function qualityScore(s: ContextState): number {
  return computeQualityScore(qualityFactors(s));
}

/**
 * Разбор оценки качества: те же факторы и веса, что в {@link qualityScore},
 * плюс итог. UI показывает состав («почему качество такое»), не пересчитывая
 * формулу у себя.
 */
export function qualityBreakdown(s: ContextState): ContextQualityBreakdown {
  const factors = qualityFactors(s);
  return {
    total: computeQualityScore(factors),
    parts: [
      { key: "load", factor: factors.load, weight: QUALITY_WEIGHT.load },
      { key: "compaction", factor: factors.compaction, weight: QUALITY_WEIGHT.compaction },
      { key: "errors", factor: factors.errors, weight: QUALITY_WEIGHT.errors },
      { key: "freshness", factor: factors.freshness, weight: QUALITY_WEIGHT.freshness },
    ],
  };
}
