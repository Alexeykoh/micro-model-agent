/**
 * LM-1/2: единые переговоры уровня reasoning с провайдером.
 *
 * В fixed-режиме раньше уровень отправлялся как есть — даже когда проба
 * показала «mechanism IGNORED» или эндпоинт не объявил granular-уровни.
 * Провайдеры вроде llama.cpp отклоняют неизвестный `reasoning` целиком.
 */
import type { ReasoningLevel } from "../../config/types";

export type ReasoningNegotiationCause = "mechanism ignored" | "no granular levels" | null;

/**
 * Возвращает clamped-уровень или undefined, если параметр нельзя отправлять.
 * @param requested запрошенный уровень (auto-политика или fixed-конфиг)
 * @param probePassed прошла ли проба механизма рассуждений
 * @param declaredLevels объявленные эндпоинтом granular-уровни
 */
export function negotiateReasoningLevel(
  requested: ReasoningLevel | undefined,
  probePassed: boolean,
  declaredLevels: readonly string[] | undefined,
): { level: ReasoningLevel | undefined; cause: ReasoningNegotiationCause } {
  if (!requested || requested === "none") return { level: requested, cause: null };
  if (!probePassed) return { level: undefined, cause: "mechanism ignored" };
  if (declaredLevels !== undefined && declaredLevels.length === 0) {
    return { level: undefined, cause: "no granular levels" };
  }
  return { level: requested, cause: null };
}
