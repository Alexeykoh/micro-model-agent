/**
 * Преобразование non-stream ответа `/chat/completions` в чанки провайдера:
 * reasoning, текст, tool calls, warning обрезки и usage. Вынесено из
 * `doNonStreaming` (`openai-compat.ts`, правило 6).
 */
import type { Chunk } from "./provider";
import type { CacheReportFormat } from "../config/types";
import { t } from "../i18n/index";
import { truncationError } from "./truncation-error";
import { parseChunkUsage } from "./usage-parse";
import { extractProviderErrorText } from "./provider-error";

/**
 * Разбирает JSON ответа. Часть бэкендов (напр. Ollama) отдают HTTP 200 с
 * `{"error": "..."}` — это ошибка, а не пустой ответ модели.
 * @throws при mid-stream/provider ошибке и обрезке до ответа.
 */
export function completionToChunks(
  data: any,
  cacheReport: CacheReportFormat,
  maxTokens: number,
): Chunk[] {
  if (data.error && !data.choices) {
    throw new Error(t("error.llm_provider_stream_error", { error: extractProviderErrorText(data.error) }));
  }
  const choice = data.choices?.[0];
  if (!choice) {
    return [];
  }

  const msg = choice.message || {};
  const chunks: Chunk[] = [];

  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (reasoning) {
    chunks.push({ type: "reasoning", content: reasoning });
  }
  if (msg.content) {
    chunks.push({ type: "text", content: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      chunks.push({
        type: "tool_call",
        toolCall: {
          id: tc.id || "",
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        },
      });
    }
  }

  // Текст готов, но упёрся в cap: видимый warning вместо молча
  // принятого обрезанного ответа (см. стрим-путь).
  if (choice.finish_reason === "length" && msg.content && !msg.tool_calls) {
    chunks.push({
      type: "warning",
      content: t("error.llm_output_truncated", { tokens: maxTokens }),
    });
  }

  // Non-streaming-путь: тот же обрыв ДО ответа, что и в стриме (см. doStream).
  if (choice.finish_reason === "length") {
    const truncation = truncationError(
      { toolCallStarted: Boolean(msg.tool_calls?.length), sawText: Boolean(msg.content), sawReasoning: Boolean(reasoning) },
      maxTokens,
    );
    if (truncation) throw truncation;
  }

  // Дописываем usage из ответа API
  const usage = parseChunkUsage(data, cacheReport);
  if (usage) chunks.push({ type: "done", usage });

  return chunks;
}
