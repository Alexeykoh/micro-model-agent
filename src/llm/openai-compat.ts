import type { LLMProvider, ChatMessage, ChatOptions, Chunk } from './provider.js';

interface OpenAIError {
  error?: { message?: string };
}

export class OpenAICompat implements LLMProvider {
  readonly model: string;
  readonly contextWindow: number;
  private baseUrl: string;
  private apiKey: string | null;

  constructor(baseUrl: string, model: string, contextWindow: number, apiKey: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.contextWindow = contextWindow;
    this.apiKey = apiKey;
  }

  async *chat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<Chunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(m => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        return msg;
      }),
      stream: true,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 4096,
    };

    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (options?.stop !== undefined) body.stop = options.stop;

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
