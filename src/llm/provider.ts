export interface LLMProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<Chunk>;
  countTokens(text: string): Promise<number>;
  model: string;
  contextWindow: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

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

export interface Chunk {
  content: string;
  reasoning?: string;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | null;
}
