/**
 * Интерфейсы для LLM-провайдеров.
 *
 * Определяет контракт для всех провайдеров:
 * - chat() — streaming-запрос к модели
 * - countTokens() — подсчёт токенов
 * - model — имя модели
 * - contextWindow — размер контекстного окна
 *
 * @module llm/provider
 */

/** Интерфейс LLM-провайдера (OpenAI-совместимый) */
export interface LLMProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<Chunk>;
  countTokens(text: string): Promise<number>;
  model: string;
  contextWindow: number;
}

/** Сообщение в диалоге с LLM */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

/** Опции для запроса к LLM */
export interface ChatOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  signal?: AbortSignal;
  showThinking?: boolean;
}

/** Streaming-чанк ответа LLM */
export interface Chunk {
  content: string;
  reasoning?: string;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | null;
}
