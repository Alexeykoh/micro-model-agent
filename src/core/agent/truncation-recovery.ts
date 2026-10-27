/**
 * Восстановление после обрыва генерации ДО первого символа ответа.
 *
 * `finish_reason=length` без текста и без tool_call означает, что бюджет
 * completion-токенов съели рассуждения модели: повтор того же запроса ничего не
 * изменит, а reasoning-политика на `recoverableLlmError` ещё и подняла бы
 * effort до `high`. Поэтому повтор ровно один и идёт «наоборот» — reasoning
 * выключен, бюджет удвоен (спека `2026-10-27-subagent-reliability-design` §B.2).
 *
 * Вынесено из `loop-llm.ts` (правило 6: файл на потолке `.arch-allowlist.json`).
 */
import type { LoopState } from "./loop-state";
import type { LlmError } from "../../llm/llm-errors";
import type { Diagnostic } from "../../output/types";
import {
  MAX_ESCALATED_COMPLETION_TOKENS,
  MAX_TRUNCATION_RETRIES,
  TRUNCATION_CAP_MULTIPLIER,
} from "./constants";
import { issueDirective, type DirectiveSink } from "./directives";
import { t } from "../../i18n/index";

/** Швы, которые нужны восстановлению (структурно — куски фазы LLM). */
export interface TruncationRecoveryDeps {
  state: LoopState;
  error: LlmError;
  logger: { diagnostic(level: string, message: string): void };
  slog: { logError(entry: Diagnostic): void };
  /** Приёмник директивы (контекст хода). */
  contextManager: DirectiveSink;
}

/**
 * Готовит повтор после обрыва до ответа.
 * @returns `true` — сигнал `continue` (повтор подготовлен), `false` — случай не наш.
 */
export function recoverTruncatedNoContent(deps: TruncationRecoveryDeps): boolean {
  const { state, error } = deps;
  if (error.kind !== "truncated_no_content") return false;
  if (state.truncationRetries >= MAX_TRUNCATION_RETRIES) return false;

  state.truncationRetries++;
  state.iterForceNoReasoning = true;
  state.iterRecoverableLlmError = false;
  const limit = error.limit;
  state.iterMaxTokensOverride =
    limit !== undefined && limit > 0
      ? Math.min(limit * TRUNCATION_CAP_MULTIPLIER, MAX_ESCALATED_COMPLETION_TOKENS)
      : undefined;

  deps.logger.diagnostic(
    "warn",
    `Truncated before output (limit ${limit ?? "?"}) — retry with reasoning off, budget ${state.iterMaxTokensOverride ?? "provider default"}`,
  );
  deps.slog.logError({
    source: "core",
    operation: "llm.call",
    kind: "degraded",
    recoverable: true,
    cause: error.message,
  });
  issueDirective(
    deps.contextManager,
    "truncated",
    t("exec.truncated_no_content", { tokens: String(limit ?? "?") }),
  );
  return true;
}
