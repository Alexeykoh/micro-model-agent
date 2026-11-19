/**
 * Обработка ошибок вызова LLM внутри итерации (`runLlmPhase`).
 *
 * Вынесено из `loop-llm.ts` (правило 6: файл на потолке `.arch-allowlist.json`):
 * разбор ошибки — отдельный шов, поток управления возвращается тем же сигналом
 * (`continue` / `break` / `return`).
 */
import { LlmError } from "../../llm/llm-errors";
import type { Logger } from "../../logger/app-logger";
import type { SessionLogger } from "../session-logger";
import type { ContextManager } from "../context/manager";
import type { PluginManager } from "../../modules/plugins/manager";
import type { AgentResult } from "../types";
import type { LoopState } from "./loop-state";
import type { LlmPhaseOutcome } from "./loop-llm";
import { MAX_LLM_ERROR_RETRIES } from "./constants";
import { recoverTruncatedNoContent } from "./truncation-recovery";
import { t } from "../../i18n/index";

/** Всё, что нужно разбору ошибки (структурно — куски фазы LLM). */
export interface LlmErrorDeps {
  /** Запрошен ли стоп (Ctrl+C / shutdown) — аборт не считается сбоем. */
  isShutdownRequested(): boolean;
  err: unknown;
  state: LoopState;
  logger: Logger;
  slog: SessionLogger;
  pluginManager: PluginManager;
  contextManager: ContextManager;
  model: string;
  /** Сколько символов ответа успело прийти до ошибки (для лога). */
  textLength: number;
  /** Момент старта вызова (мс) — длительность в логе. */
  llmStart: number;
}

/**
 * Короткая версия ошибки провайдера для пользователя: если в тексте есть JSON
 * (`{"error":{"message":"..."}}`), берём message, иначе первую строку и кап.
 */
export function friendlyLlmMessage(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === "string" && inner.trim()) {
        return `${text.slice(0, start).trim()} ${inner.trim()}`.trim().slice(0, 500);
      }
    } catch {
      /* не JSON — оставляем как есть */
    }
  }
  return text.split(/\r?\n/)[0].slice(0, 500);
}

/**
 * Разбирает ошибку вызова LLM и говорит петле, что делать дальше.
 * @returns сигнал петли: `continue` (повтор), `break` (стоп) или `return` (итог).
 */
export function handleLlmError(deps: LlmErrorDeps): LlmPhaseOutcome {
  const { err, state, logger, slog, pluginManager, contextManager } = deps;
  const e = err as { name?: string; message?: string };

  if (deps.isShutdownRequested() || e?.name === "AbortError") {
    logger.diagnostic("info", "LLM call aborted (interrupt)");
    return { kind: "break" };
  }

  // Реактивная компакция: context-length ошибка — один раз уплотняем и повторяем.
  if (
    err instanceof LlmError &&
    err.recoverable &&
    err.kind === "context_length" &&
    !state.reactiveCompactionUsed
  ) {
    state.reactiveCompactionUsed = true;
    state.iterRecoverableLlmError = true;
    state.lastCompactionIteration = state.iteration; // общий клок компакции (W4)
    const reactive = contextManager.compactAdaptive?.({
      toolResultKeep: contextManager.getToolResultKeep?.() ?? 6,
      minReduction: 0,
    });
    logger.diagnostic(
      "warn",
      `Context-length error — reactive compaction (reduced ${reactive?.reducedBy ?? 0} tokens)`,
    );
    if (reactive) {
      slog.logCompaction({
        reason: "reactive (context-length)",
        iteration: state.iteration,
        ...reactive,
      });
    }
    return { kind: "continue" };
  }

  // Обрыв до первого символа ответа: бюджет съели рассуждения. Ветка стоит
  // перед общим обработчиком — там политика подняла бы reasoning до "high".
  if (
    err instanceof LlmError &&
    recoverTruncatedNoContent({ state, error: err, logger, slog, contextManager })
  ) {
    pluginManager.runOnError({ iteration: state.iteration, logger, contextManager }, err);
    return { kind: "continue" };
  }

  // Восстановимые ошибки LLM (например, токен-лимит на середине tool_call):
  // отдаём локализованную причину обратно в контекст, чтобы модель
  // адаптировалась вместо смерти всей сессии. Ограничено во избежание цикла.
  if (
    err instanceof LlmError &&
    err.recoverable &&
    err.kind !== "truncated_no_content" &&
    state.llmErrorRetries < MAX_LLM_ERROR_RETRIES
  ) {
    state.iterRecoverableLlmError = true;
    state.llmErrorRetries++;
    logger.diagnostic(
      "warn",
      `Recoverable LLM error, feeding back (${state.llmErrorRetries}/${MAX_LLM_ERROR_RETRIES}): ${err.message}`,
    );
    slog.logError({
      source: "core",
      operation: "llm.call",
      kind: "degraded",
      recoverable: true,
      cause: err.message,
    });
    pluginManager.runOnError({ iteration: state.iteration, logger, contextManager }, err);
    contextManager.addMessage({
      role: "user",
      content: `<system-summary>${err.message}</system-summary>`,
    });
    return { kind: "continue" };
  }

  const message = e?.message ?? String(err);
  logger.logLLMResponse(deps.model, deps.textLength, Date.now() - deps.llmStart, message, "agent");
  // Диагностика — только в verbose/файле; пользователь получает один короткий
  // текст через `result.error`, а не сырой JSON дважды (B-25).
  logger.diagnostic("error", `LLM call failed: ${message}`);
  slog.logError({ source: "core", operation: "llm.call", kind: "failed", cause: message });
  pluginManager.runOnError(
    { iteration: state.iteration, logger, contextManager },
    err instanceof Error ? err : new Error(message),
  );
  const result: AgentResult = {
    success: false,
    text: state.lastText,
    error: t("error.llm", { message: friendlyLlmMessage(message) }),
    iterationCount: state.iteration,
  };
  return { kind: "return", result };
}
