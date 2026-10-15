/** Контракт LLM-провайдера: сообщения, чанки, тулы, опции чата. */
import type { ReasoningLevel } from "../config/types";
import type { CacheUsage } from "./cache-usage";

/** Текстовая часть контента сообщения. */
export interface TextPart {
  type: "text";
  text: string;
}

/** Картиночная часть контента (image_url). */
export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

/** Часть контента: текст или картинка. */
export type ContentPart = TextPart | ImageUrlPart;

/** Сообщение чата: роль, контент, тул-мета. */
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  name?: string;
}

/** Хелпер: плоский текст из контента (подсчёт токенов, логи и т.п.). */
export function getMessageText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/** Определение тула для модели: имя, описание, JSON-схема параметров. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Чанк стрима: текст/reasoning/вызов тула/done/нефатальный warning. */
export interface Chunk {
  /**
   * `warning` — нефатальное уведомление о модели-ответе (напр., обрезка по
   * лимиту completion-токенов). Не входит в текст/контекст ассистента.
   */
  type: "text" | "reasoning" | "tool_call" | "done" | "warning";
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
  finishReason?: "stop" | "length" | "tool_calls";
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Статистика кеша промпта, если провайдер её сообщил. */
    cache?: CacheUsage;
  };
}

/** Опции вызова chat: лимит токенов и уровень reasoning. */
export interface ChatOptions {
  /** Cap сгенерированных токенов на вызов (перебивает дефолт провайдера). */
  maxTokens?: number;
  /** Уровень reasoning effort. Механизм выражения — свойство провайдера (INV-R1). */
  reasoningEffort?: ReasoningLevel;
  /**
   * Id сессии-владельца запроса: перебивает провайдерский `getSessionId`.
   * Нужно параллельным раннерам — иначе заголовок `x-opencode-session` и
   * cache-ключи брались бы из main-сессии, а не из своей.
   */
  sessionId?: string;
}

/** Интерфейс LLM-провайдера: стрим чата, подсчёт токенов, список моделей. */
export interface LLMProvider {
  readonly model: string;
  readonly contextWindow: number;

  chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    options?: ChatOptions,
  ): AsyncIterable<Chunk>;

  countTokens(text: string): number;

  listModels(): Promise<string[]>;
}
