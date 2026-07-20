import type { LLMProvider, ChatMessage, ChatOptions, Chunk } from './provider.js';

/**
 * OpenAI-совместимый LLM-провайдер.
 *
 * Работает с любым сервером, реализующим OpenAI Chat Completions API:
 * - LM Studio (localhost:1234)
 * - Ollama (localhost:11434)
 * - vLLM, Together, Groq и др.
 *
 * Поддерживает streaming-ответы (SSE).
 *
 * @module llm/openai-compat
 */

interface OpenAIError {
  error?: { message?: string };
}

/** Паттерны моделей, поддерживающих reasoning/thinking */
const REASONING_MODEL_PATTERNS = [
  /qwen.*3\.5/i,
  /qwen.*3.*thinking/i,
  /deepseek.*r1/i,
  /deepseek.*reason/i,
  /\br1\b.*7b/i,
  /\br1\b.*14b/i,
  /\br1\b.*32b/i,
  /\br1\b.*70b/i,
];

/**
 * Проверяет, является ли модель reasoning-моделью.
 * Reasoning-модели отправляют reasoning_content перед content,
 * и нуждаются в большем max_tokens и enable_thinking.
 */
function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_PATTERNS.some(p => p.test(model));
}

export class OpenAICompat implements LLMProvider {
  readonly model: string;
  contextWindow: number;
  private baseUrl: string;
  private apiKey: string | null;

  constructor(baseUrl: string, model: string, contextWindow: number, apiKey: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.contextWindow = contextWindow;
    this.apiKey = apiKey;
  }

  async *chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<Chunk> {
    const reasoning = isReasoningModel(this.model);

    // Reasoning-модели требуют больший budget — reasoning токены потребляют часть max_tokens
    const defaultMaxTokens = reasoning ? 16384 : 4096;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        return msg;
      }),
      stream: true,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? defaultMaxTokens,
    };

    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.stop !== undefined) body.stop = options.stop;

    // Reasoning-модели: включаем thinking если поддерживается
    if (options?.enableThinking && reasoning) {
      // Qwen3.5 (LM Studio / vLLM): chat_template_kwargs с enable_thinking=true
      body.chat_template_kwargs = { enable_thinking: true };
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const err: OpenAIError = await response.json().catch(() => ({}));
      throw new Error(`API ${response.status}: ${err.error?.message ?? response.statusText}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { content: delta.content, finish_reason: null };
          } else if (delta?.reasoning_content) {
            yield { content: '', reasoning: delta.reasoning_content, finish_reason: null };
          }
          const finish = parsed.choices?.[0]?.finish_reason;
          if (finish) {
            yield { content: '', finish_reason: finish };
          }
        } catch { /* skip malformed chunk */ }
      }
    }
  }

  async countTokens(text: string): Promise<number> {
    const mod = await import('./token-counter.js');
    return mod.countTokens(text);
  }
}
