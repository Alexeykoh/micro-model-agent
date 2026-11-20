/** AQC-5: пороги значимости и ранняя компакция для маленьких моделей. */
import type { ContextManager } from "../../core/context/manager";
import {
  EARLY_SMALL_CONTEXT_RATIO,
  EARLY_SMALL_MESSAGE_COUNT,
  EARLY_SMALL_WINDOW_CEILING,
} from "./constants";

/**
 * Порог значимости компакции. Больше из двух: 2% бюджета истории и 3% текущего
 * (калиброванного) контекста. Привязка к контексту не даёт «сжатию впустую»
 * считаться успехом и короткозамкнуть эскалацию стадий.
 */
export function computeMinReduction(budgetHistory: number, contextTokens: number): number {
  return Math.max(Math.floor(budgetHistory * 0.02), Math.floor(contextTokens * 0.03));
}

/** Причина ранней компакции для окна ≤64K или null. */
export function earlySmallReason(cm: ContextManager): string | null {
  const window = cm.getContextWindow?.();
  if (!window || window > EARLY_SMALL_WINDOW_CEILING) return null;
  const due =
    cm.getMessageCount() >= EARLY_SMALL_MESSAGE_COUNT ||
    cm.getContextTokens() >= window * EARLY_SMALL_CONTEXT_RATIO;
  return due ? "early-small-model" : null;
}
