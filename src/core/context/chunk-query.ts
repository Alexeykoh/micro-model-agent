// RLM-стиль llm_query: ответ на запрос по большому тексту чанками + синтез.
import type { LLMProvider, Message } from "../../llm/provider";
import type { ReasoningLevel } from "../../config/types";
import type { Logger } from "../../logger/app-logger";
import { errMsg } from "../../utils";

/** Макс. символов склеенных ответов чанков для синтез-вызова. Не даёт
 * промпту синтеза вылезти за окно контекста на больших входах. */
const MAX_SYNTHESIS_INPUT_CHARS = 20_000;

/** Опции чанкового запроса: размеры, параллелизм, синтез, reasoning, логгер, abort. */
export interface ChunkQueryOptions {
  /** Примерный размер чанка в символах. По умолчанию: 12000. */
  chunkChars?: number;
  /** Макс. параллельных запросов чанков. По умолчанию: 4. */
  maxParallel?: number;
  /** Финальный синтез-вызов по всем ответам. По умолчанию: true. */
  synthesize?: boolean;
  /** Кап генерируемых токенов на вызов чанка. По умолчанию: 1024 (хватит на reasoning + ответ). */
  maxChunkTokens?: number;
  /** Кап генерируемых токенов на синтез-вызов. По умолчанию: 2048. */
  maxSynthesisTokens?: number;
  /**
   * Reasoning effort для чанк/синтез-вызовов. По умолчанию "none": на reasoning-
   * моделях (qwen3.5) длинная цепочка размышлений съедает весь maxTokens и
   * оставляет пустой текстовый ответ, молча портя результаты. Переопредели
   * в "low"/"medium"/"high", если провайдер/модель требует.
   */
  reasoningEffort?: ReasoningLevel;
  querySystemPrompt?: string;
  synthesisSystemPrompt?: string;
  /** Опциональный логгер для диагностики чанкинга/параллелизма. */
  logger?: Logger;
  /** Abort-сигнал — при срабатывании летящие чанк-вызовы быстро абортятся. */
  signal?: AbortSignal;
  /** Id сессии-владельца: cache/session-заголовки запросов. */
  sessionId?: string;
}

/** Результат чанкового запроса: чанки, ответы, синтез, объём, наблюдаемый параллелизм. */
export interface ChunkQueryResult {
  chunks: number;
  answers: string[];
  synthesis: string;
  totalChars: number;
  /** Макс. одновременно летевших чанк-запросов (для тестов/тюнинга). */
  maxParallelObserved: number;
}

/** Системный промпт чанка по умолчанию (строго по тексту, иначе NO_EVIDENCE). */
export const DEFAULT_CHUNK_SYSTEM_PROMPT =
  'Answer the query using ONLY the provided text. Be concise. If the text does not contain the answer, say "NO_EVIDENCE".';

/** Системный промпт синтеза по умолчанию (сводка ответов чанков). */
export const DEFAULT_SYNTHESIS_SYSTEM_PROMPT =
  "You are given a query and per-chunk answers over a large text. Produce the final answer to the query, combining evidence from the chunks. If no chunk had evidence, say so.";

/** Режет текст на чанки по переводам строк, каждый ≤ chunkChars символов. */
export function splitTextIntoChunks(text: string, chunkChars: number): string[] {
  if (chunkChars <= 0) throw new Error("chunkChars must be > 0");
  if (text.length <= chunkChars) return [text];
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > chunkChars) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}

async function chatText(
  provider: LLMProvider,
  messages: Message[],
  maxTokens?: number,
  reasoningEffort?: ReasoningLevel,
  signal?: AbortSignal,
  sessionId?: string,
): Promise<string> {
  let out = "";
  for await (const chunk of provider.chat(messages, undefined, signal, {
    maxTokens,
    reasoningEffort,
    sessionId,
  })) {
    if (chunk.type === "text" && chunk.content) out += chunk.content;
  }
  return out;
}

/**
 * RLM-стиль llm_query: отвечает на `query` по `text` через чанкинг и опрос
 * модели по каждому чанку фиксированным системным промптом (дружит с KV-кэшем),
 * ограниченный параллелизм и опциональный проход синтеза.
 */
export async function runChunkQuery(
  provider: LLMProvider,
  text: string,
  query: string,
  opts: ChunkQueryOptions = {},
): Promise<ChunkQueryResult> {
  const chunkChars = opts.chunkChars ?? 12000;
  const maxParallel = Math.max(1, opts.maxParallel ?? 4);
  const maxChunkTokens = opts.maxChunkTokens ?? 1024;
  const maxSynthesisTokens = opts.maxSynthesisTokens ?? 2048;
  const reasoningEffort = opts.reasoningEffort ?? "none";
  const chunks = splitTextIntoChunks(text, chunkChars);
  const answers: string[] = new Array(chunks.length);
  const chunkSystem = opts.querySystemPrompt ?? DEFAULT_CHUNK_SYSTEM_PROMPT;
  const logger = opts.logger;

  if (chunks.length === 1) {
    logger?.debug(`runChunkQuery: single chunk (${text.length} chars), no chunking needed`);
  } else {
    logger?.debug(
      `runChunkQuery: ${chunks.length} chunks over ${text.length} chars (chunkChars=${chunkChars}, maxParallel=${maxParallel})`,
    );
  }

  let cursor = 0;
  let inFlight = 0;
  let maxParallelObserved = 0;

  const signal = opts.signal;

  const workers = Array.from({ length: Math.min(maxParallel, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      if (signal?.aborted) break;
      const idx = cursor++;
      inFlight++;
      maxParallelObserved = Math.max(maxParallelObserved, inFlight);
      try {
        answers[idx] = await chatText(
          provider,
          [
            { role: "system", content: chunkSystem },
            { role: "user", content: `Query: ${query}\n\nText:\n${chunks[idx]}` },
          ],
          maxChunkTokens,
          reasoningEffort,
          signal,
          opts.sessionId,
        );
      } catch (err: any) {
        // Один упавший чанк не должен убивать весь запрос. Кладём ошибку,
        // остальные чанки + синтез идут дальше.
        const msg = errMsg(err);
        answers[idx] = `[FAILED] ${msg.slice(0, 200)}`;
        logger?.debug(`runChunkQuery: chunk ${idx + 1}/${chunks.length} failed: ${msg}`);
      } finally {
        inFlight--;
      }
    }
  });
  await Promise.all(workers);

  let synthesis = "";
  if (opts.synthesize !== false && chunks.length > 0) {
    let joined = answers
      .map((a, i) => `--- Chunk ${i + 1}/${chunks.length} ---\n${a}`)
      .join("\n\n");
    // Кап входа синтеза — защита от переполнения контекста на больших текстах.
    if (joined.length > MAX_SYNTHESIS_INPUT_CHARS) {
      const truncated = joined.slice(0, MAX_SYNTHESIS_INPUT_CHARS);
      joined = `${truncated}\n\n[TRUNCATED — synthesis input exceeded ${MAX_SYNTHESIS_INPUT_CHARS} chars]`;
      logger?.debug(
        `runChunkQuery: synthesis input truncated from ${answers.join("").length} to ${MAX_SYNTHESIS_INPUT_CHARS} chars`,
      );
    }
    logger?.debug(`runChunkQuery: synthesis pass over ${chunks.length} answers`);
    synthesis = await chatText(
      provider,
      [
        {
          role: "system",
          content: opts.synthesisSystemPrompt ?? DEFAULT_SYNTHESIS_SYSTEM_PROMPT,
        },
        { role: "user", content: `Query: ${query}\n\nChunk answers:\n${joined}` },
      ],
      maxSynthesisTokens,
      reasoningEffort,
      signal,
      opts.sessionId,
    );
  }

  logger?.debug(
    `runChunkQuery: done, ${chunks.length} chunks, max parallel observed ${maxParallelObserved}, synthesis ${synthesis.length} chars`,
  );

  return {
    chunks: chunks.length,
    answers,
    synthesis,
    totalChars: text.length,
    maxParallelObserved,
  };
}
