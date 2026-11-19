/** Парсинг чанков стрима в итоговый ответ (текст/тулы/reasoning/пусто). */
import type { Chunk } from "./provider";
import type { ToolCall } from "../core/types";

/** Распарсенный ответ: текст, вызовы тулов, reasoning или пусто. */
export type ParsedResponse =
  | { type: "text"; content: string; reasoning?: string }
  | { type: "tool_call"; calls: ToolCall[]; reasoning?: string }
  | { type: "reasoning"; content: string }
  | { type: "empty" };

/**
 * Сворачивает чанки стрима в ответ (текст склеивается, reasoning копится,
 * аргументы тулов JSON-парсятся с фолбэком {}).
 * @param chunks чанки стрима; @returns распарсенный ответ.
 */
export function parseChunks(chunks: Chunk[]): ParsedResponse {
  let text = "";
  let reasoning: string | undefined;
  const toolCalls: ToolCall[] = [];
  let hasToolCalls = false;

  for (const chunk of chunks) {
    if (chunk.type === "text" && chunk.content) {
      text += chunk.content;
    }
    if (chunk.type === "reasoning" && chunk.content) {
      reasoning = (reasoning || "") + chunk.content;
    }
    if (chunk.type === "tool_call" && chunk.toolCall) {
      hasToolCalls = true;
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(chunk.toolCall.arguments);
      } catch {
        parsedArgs = {};
      }
      toolCalls.push({
        id: chunk.toolCall.id,
        name: chunk.toolCall.name,
        arguments: parsedArgs,
      });
    }
  }

  if (hasToolCalls) {
    return { type: "tool_call", calls: toolCalls, reasoning };
  }

  if (reasoning && !text) {
    return { type: "reasoning", content: reasoning };
  }

  if (!text && !reasoning) {
    return { type: "empty" };
  }

  return { type: "text", content: text || "", reasoning };
}
