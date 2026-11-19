/**
 * Снапшот менеджера контекста для логов/наблюдаемости и веб-поверхности.
 * Вынесен из `manager.ts` (правило 6); набор и значения полей те же.
 */
import type { ContextSnapshot } from "./manager-types";
import { breakdown, estimateDiagnostics, estimatedTokens } from "./manager-estimate";
import { qualityBreakdown, qualityScore } from "./manager-quality";
import type { ContextState } from "./manager-state";

/** Снапшот текущего состояния контекста — для лога структуры контекста и статистики. */
export function snapshot(s: ContextState): ContextSnapshot {
  const diag = estimateDiagnostics(s);
  return {
    window: s.contextWindow,
    budget: { ...s.budget },
    tokens: estimatedTokens(s),
    toolTokens: s.toolTokens,
    messageCount: s.messages.length,
    quality: qualityScore(s),
    qualityBreakdown: qualityBreakdown(s),
    compactionCount: s.compactionCount,
    iterationsSinceCompaction: s.iterationsSinceCompaction,
    breakdown: breakdown(s),
    estimatedTokensRaw: diag.raw,
    contextTokens: diag.calibrated,
    calibrationRatio: diag.ratio,
    calibrationState: diag.state,
  };
}
