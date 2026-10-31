/** Учёт токенов и стоимости за запуск цикла (API-цифры + fallback-оценка). */
import type { CostTracker } from "../../modules/pricing/index";
import type { SessionLogger } from "../session-logger";
import type { SubagentUsageRecord } from "../../tools/subagent-runs";
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
    private readonly getProvenance: () => { provider: string; model: string },
    /** Приёмник per-call usage прогона (субагент пишет в журнал сессии). */
    private readonly onUsage?: (usage: SubagentUsageRecord) => void,
  ) {}

  /**
   * Начало итерации: фиксирует baseline API-токенов и аккумулирует оценку
   * prompt-токенов. Возвращает baseline для последующих вызовов.
   */
  beginIteration(
    state: LoopState,
    estimatedPromptTokens: number,
  ): { promptBefore: number; completionBefore: number; costBefore: number } {
    state.estimatedPromptTokensTotal += estimatedPromptTokens;
    // Кеш-данные относятся к одной итерации; сбрасываем, чтобы отсутствие
    // usage в следующем ходе не приписало старые цифры.
    state.cacheUsage = undefined;
    return {
      promptBefore: state.apiPromptTokens,
      completionBefore: state.apiCompletionTokens,
      costBefore: state.apiCostUsd,
    };
  }

  /**
   * done-чанк стрима: ЗАМЕНЯЕТ running-суммы (promptBefore + usage), не
   * аккумулирует — один логический запрос = один `done`.
   */
  recordApiUsage(
    state: LoopState,
    baseline: { promptBefore: number; completionBefore: number; costBefore?: number },
    usage: {
      promptTokens: number;
      completionTokens: number;
      cache?: CacheUsage;
      costUsd?: number;
    },
  ): void {
    state.apiPromptTokens = baseline.promptBefore + usage.promptTokens;
    state.apiCompletionTokens = baseline.completionBefore + usage.completionTokens;
    state.cacheUsage = usage.cache;
    // Стоимость от провайдера авторитетнее оценки по токенам; заменяем так же,
    // как токены (два done-чанка одного запроса не должны двоить сумму).
    if (usage.costUsd !== undefined) {
      state.apiCostUsd = (baseline.costBefore ?? 0) + usage.costUsd;
    }
  }

  /** Аккумулирует символы ответа — fallback-оценка completion-токенов. */
  addCompletionChars(state: LoopState, chars: number): void {
    state.apiCompletionChars += chars;
  }

  /**
   * Конец LLM-вызова: считает полную длительность и decode (от первого
   * контентного чанка), пишет per-call usage. Возвращает `durationMs`.
   */
  finishCall(
    state: LoopState,
    baseline: { promptBefore: number; completionBefore: number; costBefore?: number },
    textContent: string,
    contextTokens: number,
    iteration: number,
    startedAt: number,
    firstTokenAt: number,
    slog: SessionLogger,
  ): number {
    const end = Date.now();
    const durationMs = end - startedAt;
    state.totalLlmDuration += durationMs;
    const decodeMs = firstTokenAt ? Math.max(1, end - firstTokenAt) : 0;
    this.logUsage(
      state,
      baseline,
      textContent,
      contextTokens,
      iteration,
      durationMs,
      decodeMs,
      slog,
    );
    return durationMs;
  }

  /**
   * Per-call лог usage + запись стоимости. Источник "api", когда бэкенд
   * отдал цифры; иначе локальная оценка (контекст для prompt, chars/4 для
   * completion) — лог должен отличать реальные числа от эвристики.
   */
  logUsage(
    state: LoopState,
    baseline: { promptBefore: number; completionBefore: number; costBefore?: number },
    textContent: string,
    contextTokens: number,
    iteration: number,
    durationMs: number,
    /** Время декодирования: от первого контентного чанка до конца вызова. */
    decodeMs: number,
    slog: SessionLogger,
  ): void {
    const usagePrompt = state.apiPromptTokens - baseline.promptBefore;
    const usageCompletion = state.apiCompletionTokens - baseline.completionBefore;
    const source: "api" | "estimate" =
      usagePrompt > 0 || usageCompletion > 0 ? "api" : "estimate";
    const prompt = source === "api" ? usagePrompt : contextTokens;
    const completion = source === "api" ? usageCompletion : estimateTokens(textContent);

    // Скорость вызова: decode без префилла. Провайдер может отдать весь ответ
    // одним чанком — тогда decode почти нулевой и tok/s физически невозможен
    // (тысячи токенов/с). Такие замеры не пишем: лучше нет числа, чем ложь.
    const MAX_PLAUSIBLE_TPS = 1000;
    const minDecodeMs = completion > 0 ? (completion / MAX_PLAUSIBLE_TPS) * 1000 : 1;
    const decode = decodeMs >= minDecodeMs ? decodeMs : 0;
    if (decode > 0) {
      state.llmSpeedCalls.push({
        completionTokens: completion,
        decodeMs: Math.max(1, decode),
        source,
      });
      state.totalLlmDecodeMs += Math.max(1, decode);
    }

    // Накопление кеш-токенов за прогон (для AgentResult.cache).
    if (state.cacheUsage) {
      state.cacheCachedTotal += state.cacheUsage.cachedTokens;
      state.cacheUncachedTotal += state.cacheUsage.uncachedTokens;
      state.cacheWriteTotal += state.cacheUsage.cacheWriteTokens;
      state.cacheSource = state.cacheUsage.source;
    }

    const prov = this.getProvenance();
    slog.logLlmUsage(iteration, {
      provider: prov.provider,
      model: prov.model,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      source,
      durationMs,
      decodeMs,
      prefix: state.prefixDelta,
      cache: state.cacheUsage,
      progress: {
        totalBatches: state.totalBatches,
        novelTools: state.novelToolKeys.size,
        duplicateBatches: state.duplicateBatches,
      },
    });
    // Стоимость от провайдера (OpenCode list_cost) — авторитетный источник;
    // оценка по токенам только когда её нет.
    const costDelta = state.apiCostUsd - (baseline.costBefore ?? 0);
    this.onUsage?.({
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      origin: source,
      durationMs,
      decodeMs,
      iteration,
      provider: prov.provider,
      model: prov.model,
    });
    if (costDelta > 0) {
      this.costTracker.recordActual(costDelta, prov.provider, state.cacheUsage);
      return;
    }
    // Кеш учитываем только когда цифры пришли от API: оценка chars/4 о кеше
    // ничего не знает и не должна менять тарификацию.
    this.costTracker.record(
      prompt,
      completion,
      prov.provider,
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