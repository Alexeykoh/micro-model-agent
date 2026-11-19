// Оценка качества контекста: нормированные факторы → итог 0..100.
// Вынесено из `manager.ts` (правило ≤300 / file-size ceiling), чтобы формула и
// веса жили в одном маленьком месте и не раздували менеджер контекста.

/** Нормированные факторы качества (0..1, больше — лучше). */
export interface QualityFactors {
  /** Нагрузка контекста (1 − занято/бюджет истории). */
  load: number;
  /** Сохраняемость после компакций. */
  compaction: number;
  /** Плотность ошибок (1 − ошибки/сообщения). */
  errors: number;
  /** Свежесть (1 − итерации/интервал компакции). */
  freshness: number;
}

/** Веса составляющих качества контекста (сумма = 1). */
export const QUALITY_WEIGHT = {
  load: 0.4,
  compaction: 0.25,
  errors: 0.2,
  freshness: 0.15,
} as const;

/** Взвешенная итоговая оценка 0..100 из нормированных факторов (0..1). */
export function computeQualityScore(f: QualityFactors): number {
  const score =
    f.load * QUALITY_WEIGHT.load +
    f.compaction * QUALITY_WEIGHT.compaction +
    f.errors * QUALITY_WEIGHT.errors +
    f.freshness * QUALITY_WEIGHT.freshness;
  return Math.round(Math.min(100, Math.max(0, score * 100)));
}
