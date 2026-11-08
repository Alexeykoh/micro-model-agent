/**
 * Учёт usage/стоимости вызова LLM и нормализация ответа фазы `runLlmPhase`.
 *
 * Вынесено из `loop-llm.ts` (правило 6: файл на потолке `.arch-allowlist.json`):
 * метрики хода и сборка `LLMResponse` — отдельные швы от управляющего потока
 * петли, поэтому наружу отдаются числами и значением, без сигналов.
 */
import type { Logger } from "../../logger/app-logger";
import type { SessionLogger } from "../session-logger";
import type { ContextManager } from "../context/manager";
import type { ContextLogger } from "./context-log";
import type { LLMResponse } from "../types";
import type { LoopState } from "./loop-state";
import type { TokenTracker } from "./token-tracker";
import type { LlmStreamResult, LlmUsageBaseline } from "./loop-llm-stream";

/** Вход учёта usage одного вызова LLM. */
export interface LlmUsageInput {
  state: LoopState;
  slog: SessionLogger;
  tokenTracker: TokenTracker;
  contextManager: ContextManager;
  logger: Logger;
  model: string;
  baseline: LlmUsageBaseline;
  stream: LlmStreamResult;
  llmStart: number;
}

/**
 * Закрывает вызов LLM: символы ответа, decode-скорость, per-call usage и
 * стоимость. Возвращает длительность вызова (мс) для лога ответа.
 */
export function finalizeLlmUsage(inp: LlmUsageInput): number {
  const { state, slog, tokenTracker, contextManager, logger, model, baseline, stream } = inp;
  // Совокупная длина ответа: текст + reasoning. Отдельно reasoning важен для
  // т/с: раньше text || reasoning терял размышления, когда был ответ, и
  // estimate скорости занижалась (провайдер без usage — LM Studio/llama.cpp).
  const answer = stream.textContent + stream.reasoningContent;
  tokenTracker.addCompletionChars(state, answer.length);
  const llmDuration = tokenTracker.finishCall(
    state,
    baseline,
    answer,
    contextManager.getEstimatedTokens(),
    state.iteration,
    inp.llmStart,
    stream.firstTokenAt,
    slog,
  );
  logger.logLLMResponse(model, answer.length, llmDuration, undefined, "agent");
  return llmDuration;
}

/** Нормализует накопленный стрим в ответ для плагинов и петли. */
export function buildLlmResponse(stream: LlmStreamResult): LLMResponse | null {
  if (stream.sawToolCall) return { type: "tool_call", calls: stream.toolCalls };
  if (stream.textContent) return { type: "text", content: stream.textContent };
  if (stream.reasoningContent) return { type: "reasoning", content: stream.reasoningContent };
  return null;
}

/** Аннотация вывода модели в context-log (отдельным [OUTPUT]-блоком). */
export function recordLlmOutput(
  contextLogger: ContextLogger | undefined,
  state: LoopState,
  stream: LlmStreamResult,
): void {
  const { reasoningContent, textContent, toolCalls } = stream;
  if (!contextLogger || (!reasoningContent && !textContent && toolCalls.length === 0)) return;
  try {
    contextLogger.recordOutput({
      iteration: state.iteration,
      ts: new Date().toISOString(),
      reasoning: reasoningContent || undefined,
      text: textContent || undefined,
      toolCalls: toolCalls.map((tc) => ({ name: tc.name, arguments: tc.arguments })),
    });
  } catch {
    // Логирование контекста не должно ронять агент.
  }
}
