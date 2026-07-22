import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { doChat } from '../src/tools/subagent.js';
import type { LLMProvider, ChatMessage, Chunk } from '../src/llm/provider.js';
import type { OutputRenderer } from '../src/ui/renderer.js';

// ─── Mock renderer ─────────────────────────────────────

function createMockRenderer(): OutputRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeError: vi.fn(),
    writeWarning: vi.fn(),
    writeInfo: vi.fn(),
    writeDim: vi.fn(),
    writeSuccess: vi.fn(),
    writeMarkdownChunk: vi.fn(),
    writeNewline: vi.fn(),
    writeSpinner: vi.fn(),
    clearSpinner: vi.fn(),
    commitMarkdown: vi.fn(),
    writeBracketTag: vi.fn(),
    writeToolBuffer: vi.fn(),
    writeToolResult: vi.fn(),
    undoLastMessage: vi.fn(),
    abortSignal: undefined,
  } as unknown as OutputRenderer;
}

// ─── Mock provider ─────────────────────────────────────

function createMockProvider(chunks: Chunk[]): LLMProvider {
  return {
    model: 'test-model',
    contextWindow: 32768,
    chat: vi.fn(async function* (): AsyncIterable<Chunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }),
    countTokens: vi.fn(async () => 100),
  } as unknown as LLMProvider;
}

function createFailingProvider(error: Error): LLMProvider {
  return {
    model: 'test-model',
    contextWindow: 32768,
    chat: vi.fn(async function* (): AsyncIterable<Chunk> {
      throw error;
    }),
    countTokens: vi.fn(async () => 100),
  } as unknown as LLMProvider;
}

// ─── Tests ─────────────────────────────────────────────

describe('doChat', () => {
  let renderer: OutputRenderer;
  const originalSetTimeout = globalThis.setTimeout;

  beforeEach(() => {
    renderer = createMockRenderer();
    // Mock setTimeout to resolve immediately for retry tests
    globalThis.setTimeout = ((fn: Function) => { fn(); return 0 as any; }) as any;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
  });

  it('returns response on success', async () => {
    const provider = createMockProvider([
      { content: 'Hello', reasoning: null, finish_reason: null },
      { content: '', reasoning: null, finish_reason: 'stop' },
    ]);
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

    const result = await doChat(provider, messages, renderer, undefined, 1, false);

    expect(result.response).toBe('Hello');
    expect(result.genTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty response on AbortError without retry', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const provider = createFailingProvider(abortError);
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

    const result = await doChat(provider, messages, renderer, undefined, 2, false);

    expect(result.response).toBe('');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('retries on network error (fetch failed)', async () => {
    let callCount = 0;
    const provider = {
      model: 'test-model',
      contextWindow: 32768,
      chat: vi.fn(async function* (): AsyncIterable<Chunk> {
        callCount++;
        if (callCount <= 2) {
          throw new Error('fetch failed');
        }
        yield { content: 'recovered', reasoning: null, finish_reason: null };
        yield { content: '', reasoning: null, finish_reason: 'stop' };
      }),
      countTokens: vi.fn(async () => 100),
    } as unknown as LLMProvider;

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await doChat(provider, messages, renderer, undefined, 3, false);

    expect(result.response).toBe('recovered');
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it('returns empty after exhausting retries on network error', async () => {
    const provider = createFailingProvider(new Error('fetch failed'));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

    const result = await doChat(provider, messages, renderer, undefined, 2, false);

    expect(result.response).toBe('');
    // 1 initial + 2 retries = 3 calls
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  it('shows retry warning on network error', async () => {
    const provider = createFailingProvider(new Error('ECONNREFUSED'));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

    await doChat(provider, messages, renderer, undefined, 1, false);

    const warnings = (renderer.writeWarning as any).mock.calls.map((c: any) => c[0]);
    expect(warnings.some((w: string) => w.includes('retrying'))).toBe(true);
  });

  it('shows server check warning after all retries fail', async () => {
    const provider = createFailingProvider(new Error('fetch failed'));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

    await doChat(provider, messages, renderer, undefined, 1, false);

    const warnings = (renderer.writeWarning as any).mock.calls.map((c: any) => c[0]);
    expect(warnings.some((w: string) => w.includes('Check that your server'))).toBe(true);
  });

  it('does not retry API errors (status codes)', async () => {
    const provider = createFailingProvider(new Error('API 429: rate limited'));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];

    const result = await doChat(provider, messages, renderer, undefined, 3, false);

    expect(result.response).toBe('');
    // Should NOT retry API errors
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('retries on empty response', async () => {
    let callCount = 0;
    const provider = {
      model: 'test-model',
      contextWindow: 32768,
      chat: vi.fn(async function* (): AsyncIterable<Chunk> {
        callCount++;
        if (callCount === 1) {
          yield { content: '', reasoning: 'thinking', finish_reason: null };
          yield { content: '', reasoning: null, finish_reason: 'stop' };
        } else {
          yield { content: 'got it', reasoning: null, finish_reason: null };
          yield { content: '', reasoning: null, finish_reason: 'stop' };
        }
      }),
      countTokens: vi.fn(async () => 100),
    } as unknown as LLMProvider;

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await doChat(provider, messages, renderer, undefined, 2, false);

    expect(result.response).toBe('got it');
  });
});
