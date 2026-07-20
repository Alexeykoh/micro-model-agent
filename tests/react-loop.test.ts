import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactLoop } from '../src/agent/react-loop.js';
import type { LLMProvider, ChatMessage } from '../src/llm/provider.js';

// Mock doChat to control LLM responses
const mockResponses: string[] = [];
let responseIdx = 0;

vi.mock('../src/tools/subagent.js', () => ({
  doChat: vi.fn(async () => {
    const response = mockResponses[responseIdx++] || '';
    return { response };
  }),
  extractAllToolCalls: vi.fn(() => []),
  validateToolCall: vi.fn(() => ({ valid: false })),
}));

vi.mock('../src/logger.js', () => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

function createMockProvider(contextWindow = 32000): LLMProvider {
  return {
    model: 'test-model',
    contextWindow,
    chat: vi.fn(),
  } as any;
}

describe('reactLoop', () => {
  beforeEach(() => {
    mockResponses.length = 0;
    responseIdx = 0;
  });

  it('finishes without tool calls (single response)', async () => {
    mockResponses.push('Hello! How can I help?');
    const result = await reactLoop({
      provider: createMockProvider(),
      systemPrompt: 'You are a helpful assistant.',
      maxSteps: 10,
    });
    expect(result.response).toBe('Hello! How can I help?');
    expect(result.steps).toBe(1);
  });

  it('handles empty responses with retries', async () => {
    mockResponses.push('', '', '', 'finally something');
    const onEmptyResponse = vi.fn();
    await reactLoop({
      provider: createMockProvider(),
      systemPrompt: 'Test',
      maxSteps: 10,
    }, { onEmptyResponse });
    expect(onEmptyResponse).toHaveBeenCalled();
  });

  it('respects maxSteps limit', async () => {
    // Each step returns a response with tool calls that we'll ignore
    for (let i = 0; i < 20; i++) {
      mockResponses.push(`Response ${i}`);
    }
    const result = await reactLoop({
      provider: createMockProvider(),
      systemPrompt: 'Test',
      maxSteps: 3,
    });
    // Should stop at maxSteps
    expect(result.steps).toBeLessThanOrEqual(3);
  });

  it('calls onStepStart for each step', async () => {
    mockResponses.push('Step 1', 'Step 2');
    const onStepStart = vi.fn();
    await reactLoop({
      provider: createMockProvider(),
      systemPrompt: 'Test',
      maxSteps: 5,
    }, { onStepStart });
    expect(onStepStart).toHaveBeenCalled();
  });

  it('returns messages array', async () => {
    mockResponses.push('Hello');
    const result = await reactLoop({
      provider: createMockProvider(),
      systemPrompt: 'System prompt',
      maxSteps: 5,
    });
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('System prompt');
  });

  it('handles onAfterLLM hook', async () => {
    mockResponses.push('Original response');
    const onAfterLLM = vi.fn(() => 'Modified response');
    const result = await reactLoop({
      provider: createMockProvider(),
      systemPrompt: 'Test',
      maxSteps: 5,
    }, { onAfterLLM });
    expect(onAfterLLM).toHaveBeenCalled();
    // The modified response should be in messages
    const assistantMsg = result.messages.find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Modified response');
  });
});
