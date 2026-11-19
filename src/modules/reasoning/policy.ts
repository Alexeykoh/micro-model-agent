// Политика reasoning-уровня: подъём на сбоях/плане, спад на рутине (policy.ts).
import type { ReasoningLevel } from "../../config/types";

/** Вход политики: события итерации + базовый уровень из конфига. */
export interface PolicyInput {
  /** Итерация вызвана hallucination-retry. */
  hallucinationRetry: boolean;
  /** Итерация вызвана отклонением финального аудита. */
  auditRejection: boolean;
  /** Итерация вызвана recoverable-ошибкой LLM. */
  recoverableLlmError: boolean;
  /** На итерации создан/перепланирован план. */
  planCreated: boolean;
  /** Подряд успешных файловых вызовов на текущем шаге. */
  consecutiveSuccesses: number;
  /** Stuck-детектор сообщает о повторяющихся вызовах. */
  isRepetitive: boolean;
  /** Базовый уровень из конфига (уровень по умолчанию). */
  baseline: ReasoningLevel;
}

/** Решение политики: уровень + причина. */
export interface PolicyResult {
  level: ReasoningLevel;
  reason: string;
}

/** Состояние политики: затухание подъёма и буст от создания плана. */
export interface PolicyState {
  /** Итераций с последнего подъёма. */
  iterationsSinceRaise: number;
  /** Если >0 — держать подъём ещё столько итераций (создан план). */
  boostRemaining: number;
}

/** Начальное состояние политики. */
export function createPolicyState(): PolicyState {
  return { iterationsSinceRaise: 0, boostRemaining: 0 };
}

const DECAY_THRESHOLD = 5;

/** Вычисляет reasoning-уровень: подъём на сбоях, буст после плана, спад на рутине. */
export function evaluateReasoningPolicy(
  input: PolicyInput,
  state: PolicyState,
): PolicyResult {
  // Сигналы подъёма (высший приоритет)
  if (input.hallucinationRetry || input.auditRejection || input.recoverableLlmError) {
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: input.hallucinationRetry ? "policy:hallucination-retry" : input.auditRejection ? "policy:audit-rejection" : "policy:recoverable-llm-error" };
  }

  // Создан план → буст на N итераций
  if (input.planCreated) {
    state.boostRemaining = 3;
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: "policy:plan-created" };
  }

  // Активный буст от создания плана
  if (state.boostRemaining > 0) {
    state.boostRemaining--;
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: "policy:plan-boost" };
  }

  // Сигналы понижения
  if (input.consecutiveSuccesses >= 2) {
    state.iterationsSinceRaise++;
    return { level: "low", reason: "policy:routine-write" };
  }

  // Зацикливание (тот же тул/аргументы повторно) — не рутина, а застревание:
  // поднимаем усилие, а не понижаем (раньше здесь стоял "low", из-за чего
  // 9B крутила один и тот же вызов на минимальном reasoning — ses_muwinhpk).
  if (input.isRepetitive) {
    state.iterationsSinceRaise = 0;
    return { level: "high", reason: "policy:repetitive-tools" };
  }

  // Затухание: подъём держался слишком долго — возврат к базовому
  if (state.iterationsSinceRaise >= DECAY_THRESHOLD) {
    state.iterationsSinceRaise = 0;
    return { level: input.baseline, reason: "policy:decay" };
  }

  // По умолчанию: базовый уровень
  state.iterationsSinceRaise++;
  return { level: input.baseline, reason: "policy:default" };
}
