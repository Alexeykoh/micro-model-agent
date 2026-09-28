/** Резолвер уровня reasoning на итерацию: override → политика → фикс. */
import { evaluateReasoningPolicy } from "../../modules/reasoning/policy";
import type { PolicyState } from "../../modules/reasoning/policy";
import type { ReasoningConfig, ReasoningLevel, ReasoningStrategy } from "../../config/types";
import type { ReasoningState } from "../../tools/set-thinking";
import type { LoopState } from "./loop-state";

/** Откуда взят текущий уровень reasoning — для логирования и диагностики. */
export type ReasoningSource = "policy" | "agent_override" | "fixed" | "none";

/** Решение резолвера: уровень effort, стратегия, источник. */
export interface ReasoningDecision {
  /** Эффективный уровень effort. undefined = механизм не применяется. */
  level: ReasoningLevel | undefined;
  /** Стратегия выражения effort на данном провайдере. */
  strategy: ReasoningStrategy | undefined;
  /** Источник решения. */
  source: ReasoningSource;
}

/**
 * Резолвер уровня reasoning на итерацию.
 *
 * Приоритет (сохранён из agent.ts):
 * 1. Активный override от set_thinking (в окне overrideCooldown) — побеждает
 *    и auto-режим, и фиксированный.
 * 2. auto-режим + пройденный probe — политика (повышение на халлюцинации/
 *    отказе аудита/ошибке LLM, понижение на рутине и повторах, затухание).
 * 3. Фиксированный режим.
 *
 * ВАЖНО: сигналы политики (iter*) описывают события ПРЕДЫДУЩЕЙ итерации —
 * они выставляются на retry-путях перед `continue`, поэтому политика должна
 * оцениваться ДО их очистки (это делает вызывающий код через
 * clearIterationSignals сразу после resolve).
 */
export class ReasoningEffortResolver {
  /**
   * Вычисляет уровень reasoning на итерацию (override → политика → фикс).
   * @param deps состояние цикла, политика, конфиг, probe, стратегия.
   * @returns уровень, стратегия и источник решения.
   */
  resolve(deps: {
    state: LoopState;
    policyState: PolicyState;
    reasoningConfig: ReasoningConfig | undefined;
    probePassed: boolean;
    reasoningStrategy: ReasoningStrategy | undefined;
    reasoningState: ReasoningState;
  }): ReasoningDecision {
    const { state, reasoningConfig, reasoningState } = deps;
    let level: ReasoningLevel | undefined;
    const strategy = deps.reasoningStrategy;
    let source: ReasoningSource = "policy";

    const overrideCooldown = reasoningConfig?.overrideCooldown ?? 0;
    const overrideAge = state.iteration - reasoningState.overrideIteration;
    const overrideActive =
      overrideCooldown > 0 &&
      reasoningState.overrideIteration >= 0 &&
      overrideAge > 0 &&
      overrideAge <= overrideCooldown;

    if (reasoningState.manual) {
      level = reasoningState.level;
      source = "agent_override";
    } else if (overrideActive) {
      level = reasoningState.level;
      source = "agent_override";
    } else if (reasoningConfig && reasoningConfig.mode === "auto" && deps.probePassed) {
      const policyResult = evaluateReasoningPolicy(
        {
          hallucinationRetry: state.iterHallucinationRetry,
          auditRejection: state.iterAuditRejection,
          recoverableLlmError: state.iterRecoverableLlmError,
          planCreated: state.iterPlanCreated,
          consecutiveSuccesses: state.consecutiveToolSuccesses,
          isRepetitive: state.iterRepetitive,
          // Baseline — настроенный минимум (`min`, по умолчанию "low"),
          // чтобы конфиг без явного baseline не жёг "medium" на пустяках.
          // Политика всё равно повышает уровень по сигналам.
          baseline: reasoningConfig.baseline ?? reasoningConfig.min,
        },
        deps.policyState,
      );
      level = policyResult.level;
      source = "policy";
    } else if (reasoningConfig && reasoningConfig.mode !== "auto") {
      level = reasoningConfig.mode;
      source = "fixed";
    }

    return { level, strategy, source };
  }
}