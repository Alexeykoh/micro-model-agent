import type { LLMProvider, Message } from "../../llm/provider";
import type { ReasoningLevel } from "../../config/types";
import type { Logger } from "../../logger/app-logger";

/** Max chars of joined chunk answers sent to the synthesis call. Prevents the
 * synthesis prompt from exceeding the model's context window on large inputs. */
const MAX_SYNTHESIS_INPUT_CHARS = 20_000;

export interface ChunkQueryOptions {
  /** Approx chunk size in chars. Default: 12000. */
  chunkChars?: number;
  /** Max concurrent chunk queries. Default: 4. */
  maxParallel?: number;
  /** Run a final synthesis call over all answers. Default: true. */
  synthesize?: boolean;
  /** Cap on generated tokens per chunk call. Default: 1024 (must fit reasoning + answer). */
  maxChunkTokens?: number;
  /** Cap on generated tokens for the synthesis call. Default: 2048. */
  maxSynthesisTokens?: number;
  /**
   * Reasoning effort for chunk/synthesis calls. Defaults to "none": on reasoning
   * models (qwen3.5) a long thinking chain can consume all of maxTokens and leave
   * an empty text answer, which silently corrupts chunk query results. Override
   * to "low"/"medium"/"high" when the provider/model needs it.
   */
  reasoningEffort?: ReasoningLevel;
  querySystemPrompt?: string;
  synthesisSystemPrompt?: string;
  /** Optional logger for chunking/parallelism diagnostics. */
  logger?: Logger;
  /** Abort signal — when fired, in-flight chunk calls abort promptly. */
  signal?: AbortSignal;
}

export interface ChunkQueryResult {
  chunks: number;
  answers: string[];
  synthesis: string;
  totalChars: number;
  /** Highest number of chunk queries in flight at once (for tests/tuning). */
  maxParallelObserved: number;
}

export const DEFAULT_CHUNK_SYSTEM_PROMPT =
  'Answer the query using ONLY the provided text. Be concise. If the text does not contain the answer, say "NO_EVIDENCE".';

export const DEFAULT_SYNTHESIS_SYSTEM_PROMPT =
  "You are given a query and per-chunk answers over a large text. Produce the final answer to the query, combining evidence from the chunks. If no chunk had evidence, say so.";

/** Split text into newline-aware chunks, each <= chunkChars chars. */
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
): Promise<string> {
  let out = "";
  for await (const chunk of provider.chat(messages, undefined, signal, {
    maxTokens,
    reasoningEffort,
  })) {
    if (chunk.type === "text" && chunk.content) out += chunk.content;
  }
  return out;
}

/**
 * RLM-style llm_query: answer `query` over `text` by chunking and querying the
 * model per chunk with a fixed system prompt (KV-cache friendly), bounded
 * concurrency, and an optional synthesis pass.
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
        );
      } catch (err: any) {
        // A single failing chunk must not kill the entire query. Store the
        // error and let the remaining chunks + synthesis proceed.
        const msg = err instanceof Error ? err.message : String(err);
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
    // Cap synthesis input to prevent context overflow on large texts.
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
