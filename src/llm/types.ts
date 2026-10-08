/** Типы результатов оркестратора и сабтасков MoE. */
import type { MoEPlan } from "../modules/execution/types";

/** Результат оркестратора: план, финальный ответ или запрос на переплан. */
export interface OrchestratorResult {
  type: "plan" | "final" | "replan";
  plan?: MoEPlan;
  finalAnswer?: string;
  explanation?: string;
}

/** Результат одного сабтаска MoE-плана. */
export interface SubtaskResult {
  subtaskId: string;
  success: boolean;
  summary: string;
  result: string;
  error?: string;
  /**
   * Есть только у результатов движка исполнения (см. execution/types.ts).
   */
  durationMs?: number;
}

/** Вход верификатора плана: план, результаты сабтасков, ошибки и варнинги. */
export interface VerifyInput {
  plan: MoEPlan;
  results: SubtaskResult[];
  verifierErrors: string[];
  verifierWarnings: string[];
  /**
   * id сабтасков, упавших по контентным причинам — только их имеет смысл
   * перепланировать. Инфраструктурные фейлы (провайдер/транспорт) MoE-цикл
   * останавливает ДО вызова верификатора.
   */
  failedSubtaskIds?: string[];
}
