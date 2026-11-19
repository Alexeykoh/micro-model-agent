/**
 * Финал стрима OpenAI-совместимого провайдера: `finishReason`/usage в `done`,
 * обрезка по completion-лимиту. Вынесено из `streamOnce` (правило 6).
 */
import type { Chunk } from "./provider";
import { t } from "../i18n/index";
import { truncationError } from "./truncation-error";
import type { StreamState } from "./stream-state";
import type { ToolCallAcc } from "./openai-sse";

/**
 * Отдаёт финальный `done` и warning/ошибку обрезки. Брошенный truncationError
 * идёт ПОСЛЕ `done` — как в исходном цикле (`done` уже устримлен).
 */
export function* finalizeStream(
  st: StreamState,
  toolCallAccs: Map<number, ToolCallAcc>,
  maxTokens: number,
): Generator<Chunk> {
  // `done` без usage, но с finish_reason — штатный финал стрима: цикл
  // агента берёт отсюда `finishReason` (раньше поле терялось, и в
  // `session.jsonl` не было ни `finish`, ни признака обрезки).
  const finishReason =
    st.lastFinishReason === "stop" ||
    st.lastFinishReason === "length" ||
    st.lastFinishReason === "tool_calls"
      ? st.lastFinishReason
      : undefined;
  if (st.usage || finishReason) {
    yield { type: "done", usage: st.usage, finishReason };
  }

  // finish_reason "length": completion упёрся в лимит токенов. Незаконченный
  // tool_call иначе молча глотается (tool_calls отдаются только на
  // finish_reason "tool_calls") и всплывает пустым ответом → слепые
  // hallucination-ретраи. Показываем настоящую причину.
  if (st.lastFinishReason === "length") {
    // Провайдер в порядке — модель превысила completion-лимит. terminal:
    // стрим не ретраим; recoverable: цикл вернёт причину модели.
    const err = truncationError(
      { toolCallStarted: st.sawToolCallStart && toolCallAccs.size > 0, sawText: st.sawText, sawReasoning: st.sawReasoning },
      maxTokens,
    );
    if (err) throw err;
    // Текст уже устримлен и не завершён — не глушим ответ, но и не
    // принимаем обрезок молча: отдаём видимое предупреждение.
    yield {
      type: "warning",
      content: t("error.llm_output_truncated", { tokens: maxTokens }),
    };
  }
}
