/** Состояние одного LLM-стрима: флаги, usage, снимок для debug. */
/**
 * Состояние одного LLM-стрима.
 *
 * Раньше в `streamOnce` openai-compat было 9 разрозненных переменных
 * (sawDone, sawText, sawToolCallStart, parsedChunks, nonDataLines,
 * nonDataSamples, midStreamError, usage, lastFinishReason) — флаг-спагетти,
 * из которого вывод о завершении стрима собирался вручную. Здесь они
 * сгруппированы в один объект (зеркало loop-state.ts в агентном цикле),
 * а итог стрима отдаётся единым снимком для debug-лога.
 */
import type { CacheUsage } from "./cache-usage";

export class StreamState {
  sawDone = false;
  sawText = false;
  /** Модель отдала рассуждения — для честной формулировки обрыва. */
  sawReasoning = false;
  /** tool_call начал накапливаться — сервер закоммитился на ответ. */
  sawToolCallStart = false;
  parsedChunks = 0;
  /** Не-SSE строки (Ollama NDJSON, комментарии, keep-alive) — для диагностики. */
  nonDataLines = 0;
  nonDataSamples: string[] = [];
  /** Провайдер прислал {"error": ...} уже после старта генерации. */
  midStreamError: string | null = null;
  usage:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cache?: CacheUsage;
      }
    | undefined;
  lastFinishReason: string | undefined;

  /** Снимок для debug-лога по завершении стрима. */
  snapshot(): Record<string, unknown> {
    return {
      sawDone: this.sawDone,
      lastFinishReason: this.lastFinishReason ?? null,
      sawText: this.sawText,
      sawReasoning: this.sawReasoning,
      sawToolCallStart: this.sawToolCallStart,
      parsedChunks: this.parsedChunks,
      nonDataLines: this.nonDataLines,
      nonDataSamples: this.nonDataLines > 0 ? this.nonDataSamples : undefined,
    };
  }
}