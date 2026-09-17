import type { CostTracker } from "../../modules/pricing/index";
import type { SessionLogger } from "../session-logger";
import { estimateTokens } from "../../llm/token-counter";
import type { CacheUsage } from "../../llm/cache-usage";
import type { LoopState } from "./loop-state";

/**
 * Учёт токенов и стоимости за один запуск цикла.
 *
 * Отвечает за три вещи, которые в agent.ts были размазаны по циклу:
 * 1) замену (НЕ аккумуляцию) running-сумм prompt/completion-токенов из
 *    done-чанка стрима — `chat()` вызывается один раз за итерацию, поэтому
 *    суммировать нельзя (иначе один реальный запрос посчитается дважды);
 * 2) per-call лог usage + запись стоимости в CostTracker, с честным
 *    разделением источника ("api" против локальной оценки, т.к. llama.cpp
 *    часто опускает `usage` в стриминге);
 * 3) финальные метрики результата: API-токены, если бэкенд их отдал,
 *    иначе fallback-оценка (~4 символа на токен).
 */
export class TokenTracker {
  constructor(
    private readonly costTracker: CostTracker,
    private readonly getProviderName: () => string,
  ) {}

  /**
   * Начало итерации: фиксирует baseline API-токенов и аккумулирует оценку
   * prompt-токенов. Возвращает baseline для последующих вызовов.
   */
  beginIteration(
    state: LoopState,
    estimatedPromptTokens: number,
  ): { promptBefore: number; completionBefore: number } {
    state.estimatedPromptTokensTotal += estimatedPromptTokens;
    return {
      promptBefore: state.apiPromptTokens,
      completionBefore: state.apiCompletionTokens,
    };
  }

  /**
   * done-чанк стрима: ЗАМЕНЯЕТ running-суммы (promptBefore + usage), не
   * аккумулирует — один логический запрос = один `done`.
   */
  recordApiUsage(
    state: LoopState,
    baseline: { promptBefore: number; completionBefore: number },
    usage: { promptTokens: number; completionTokens: number; cache?: CacheUsage },
  ): void {
    state.apiPromptTokens = baseline.promptBefore + usage.promptTokens;
    state.apiCompletionTokens = baseline.completionBefore + usage.completionTokens;
    state.cacheUsage = usage.cache;
  }

  /** Аккумулирует символы ответа — fallback-оценка completion-токенов. */
  addCompletionChars(state: LoopState, chars: number): void {
    state.apiCompletionChars += chars;
  }

  /**
   * Per-call лог usage + запись стоимости. Источник "api", когда бэкенд
   * отдал цифры; иначе локальная оценка (контекст для prompt, chars/4 для
   * completion) — лог должен отличать реальные числа от эвристики.
   */
  logUsage(
    state: LoopState,
    baseline: { promptBefore: number; completionBefore: number },
    textContent: string,
    contextTokens: number,
    iteration: number,
    durationMs: number,
    slog: SessionLogger,
  ): void {
    const usagePrompt = state.apiPromptTokens - baseline.promptBefore;
    const usageCompletion = state.apiCompletionTokens - baseline.completionBefore;
    const source: "api" | "estimate" =
      usagePrompt > 0 || usageCompletion > 0 ? "api" : "estimate";
    const prompt = source === "api" ? usagePrompt : contextTokens;
    const completion = source === "api" ? usageCompletion : estimateTokens(textContent);
    slog.logLlmUsage(iteration, {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      source,
      durationMs,
      prefix: state.prefixDelta,
    });
    // Кеш учитываем только когда цифры пришли от API: оценка chars/4 о кеше
    // ничего не знает и не должна менять тарификацию.
    this.costTracker.record(
      prompt,
      completion,
      this.getProviderName(),
      source === "api" ? state.cacheUsage : undefined,
    );
  }

  /**
   * Финальные метрики результата. API-токены в приоритете; иначе — сумма
   * оценок prompt по итерациям и символы completion (~4 символа/токен).
   */
  resolveFinal(state: LoopState): { prompt: number; completion: number; total: number } {
    if (state.apiPromptTokens > 0 || state.apiCompletionTokens > 0) {
      return {
        prompt: state.apiPromptTokens,
        completion: state.apiCompletionTokens,
        total: state.apiPromptTokens + state.apiCompletionTokens,
      };
    }
    const prompt = Math.max(1, state.estimatedPromptTokensTotal);
    const completion = Math.max(0, Math.ceil(state.apiCompletionChars / 4));
    return { prompt, completion, total: prompt + completion };
  }
}