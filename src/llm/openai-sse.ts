/**
 * Разбор SSE/NDJSON-потока OpenAI-совместимого провайдера: одна строка →
 * чанки. Вынесено из `streamOnce` (`openai-compat.ts`, правило 6). Сборка
 * tool-call-дельт и usage — здесь, состояние стрима — в `StreamState`.
 */
import type { Chunk } from "./provider";
import type { CacheReportFormat } from "../config/types";
import { t } from "../i18n/index";
import { StreamState } from "./stream-state";
import { parseChunkUsage } from "./usage-parse";
import { extractProviderErrorText } from "./provider-error";

export interface ToolCallAcc {
  id: string;
  name: string;
  arguments: string;
}

/** Куда писать отладочные сведения (логгер провайдера). */
export type SseDebug = ((msg: string, meta?: Record<string, unknown>) => void) | null;

/** Сливает дельту tool call в аккумулятор по индексу. */
export function mergeToolCallDeltas(
  accs: Map<number, ToolCallAcc>,
  deltas: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const tc of deltas) {
    const idx = tc.index ?? 0;
    if (!accs.has(idx)) {
      accs.set(idx, { id: "", name: "", arguments: "" });
    }
    const acc = accs.get(idx)!;
    if (tc.id) acc.id = tc.id;
    if (tc.function?.name) acc.name = tc.function.name;
    if (tc.function?.arguments) {
      acc.arguments += tc.function.arguments;
    }
  }
}

/** Готовые tool call'ы из аккумуляторов (в порядке индексов). */
export function assembledToolCalls(accs: Map<number, ToolCallAcc>): Chunk[] {
  const chunks: Chunk[] = [];
  for (const [, acc] of accs) {
    if (acc.name) {
      chunks.push({
        type: "tool_call",
        toolCall: {
          id: acc.id,
          name: acc.name,
          arguments: acc.arguments || "{}",
        },
      });
    }
  }
  return chunks;
}

/**
 * Разбирает одну строку потока. `[DONE]` и пустые строки дают пусто; битый
 * JSON пропускается; mid-stream ошибка провайдера поднимается после строки.
 */
export function* parseStreamLine(
  line: string,
  st: StreamState,
  toolCallAccs: Map<number, ToolCallAcc>,
  cacheReport: CacheReportFormat,
  debug: SseDebug,
): Generator<Chunk> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let data: string;
  if (trimmed.startsWith("data: ")) {
    data = trimmed.slice(6);
    if (data === "[DONE]") {
      st.sawDone = true;
      return;
    }
  } else {
    // Не SSE-фрейм — Ollama (и часть бэкендов) стримят NDJSON или шлют
    // mid-stream ошибки голым JSON. Пробуем парсить сырую строку;
    // непарсящийся шум (SSE-комменты, keep-alive) считаем и пропускаем.
    st.nonDataLines++;
    if (st.nonDataSamples.length < 5) st.nonDataSamples.push(trimmed.slice(0, 200));
    data = trimmed;
  }

  try {
    const parsed = JSON.parse(data);
    st.parsedChunks++;
    const choice = parsed.choices?.[0];
    // Usage читаем независимо от `choices`: часть провайдеров (OpenCode
    // Go) присылает его в чанке с непустым choices и finish_reason.
    const parsedUsage = parseChunkUsage(parsed, cacheReport);
    if (parsedUsage) {
      st.usage = parsedUsage;
      debug?.("LLM stream usage", { ...st.usage });
    }
    if (!choice) {
      if (!parsed.usage && parsed.error) {
        // Mid-stream ошибка провайдера (Ollama шлёт {"error": "..."}
        // голым JSON после старта генерации; LM Studio — объект
        // `{message, ...}`, где `String()` давал `[object Object]`).
        // Показываем — глотание даст молча пустой ответ.
        // Брошено ВНЕ try/catch JSON-парсинга ниже.
        st.midStreamError = extractProviderErrorText(parsed.error);
      }
      // NOTE: `continue` тут нет — он пропустил бы throw midStreamError
      // ниже (он вне этого try/catch).
    } else {
      if (st.parsedChunks <= 3 || st.parsedChunks % 50 === 0) {
        const d = choice.delta ?? {};
        debug?.("LLM stream chunk", {
          n: st.parsedChunks,
          finishReason: choice.finish_reason ?? null,
          deltaKeys: Object.keys(d),
        });
      }

      const delta = choice.delta || {};
      const finishReason = choice.finish_reason;
      if (finishReason) st.lastFinishReason = finishReason;

      // `reasoning` — алиас Ollama для openai-`reasoning_content`.
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (reasoningDelta) {
        st.sawReasoning = true;
        yield { type: "reasoning", content: reasoningDelta };
      }

      if (delta.tool_calls) {
        st.sawToolCallStart = true;
        mergeToolCallDeltas(toolCallAccs, delta.tool_calls);
      }

      if (delta.content) {
        st.sawText = true;
        yield { type: "text", content: delta.content };
      }

      if (finishReason === "tool_calls" && toolCallAccs.size > 0) {
        for (const chunk of assembledToolCalls(toolCallAccs)) yield chunk;
        toolCallAccs.clear();
      }
    }
  } catch {
    // Битые JSON-строки пропускаем
  }
  if (st.midStreamError) {
    throw new Error(
      t("error.llm_provider_stream_error", { error: st.midStreamError.slice(0, 300) }),
    );
  }
}
