import { describe, it, expect, beforeAll } from 'vitest';
import { OpenAICompat } from '../src/llm/openai-compat.js';
import type { ChatMessage } from '../src/llm/provider.js';

const BASE_URL = process.env.MMA_LLM_URL || 'http://localhost:1234/v1';
const MODEL = process.env.MMA_LLM_MODEL || 'qwen/qwen3.5-9b';
const CTX = parseInt(process.env.MMA_CTX || '32768', 10);

let provider: OpenAICompat;

beforeAll(() => {
  provider = new OpenAICompat(BASE_URL, MODEL, CTX);
});

async function chat(msgs: ChatMessage[]): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of provider.chat(msgs, { temperature: 0.3, max_tokens: 2048 })) {
    if (chunk.content) chunks.push(chunk.content);
  }
  return chunks.join('');
}

async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Skip entire suite if model is not reachable
describe('LLM integration', () => {
  it.skip('placeholder — skipping if no model', async () => {});

  it('responds to simple prompt', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'Answer briefly in one sentence.' },
      { role: 'user', content: 'What is 2 + 2?' },
    ]);
    expect(response.length).toBeGreaterThan(0);
  }, 30000);

  it('generates tool call format', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'You have a tool called bash. To use it output: <tool_call>{"name":"bash","arguments":{"cmd":"echo hello"}}</tool_call>. Use it now.' },
      { role: 'user', content: 'Run echo hello' },
    ]);
    expect(response).toContain('<tool_call>');
    expect(response).toContain('bash');
  }, 30000);

  it('responds to explicit instruction', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'Output exactly this and nothing else: <tool_call>{"name":"read_file","arguments":{"path":"test.ts"}}</tool_call>' },
      { role: 'user', content: 'go' },
    ]);
    expect(response.length).toBeGreaterThan(0);
  }, 30000);

  it('follows multi-step instructions', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'You are a helpful assistant. Follow instructions step by step.' },
      { role: 'user', content: 'Do these 3 things: 1) Say "Step 1 done" 2) Say "Step 2 done" 3) Say "All done"' },
    ]);
    expect(response).toContain('done');
  }, 30000);

  it('responds in Russian when asked', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'Отвечай только на русском языке.' },
      { role: 'user', content: 'Привет! Как дела?' },
    ]);
    expect(response.length).toBeGreaterThan(0);
    expect(response).toMatch(/[а-яА-ЯёЁ]/);
  }, 30000);

  it('creates file content via tool call', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'Use filesystem tools. To write a file output: <tool_call>{"name":"write_file","arguments":{"path":"test.txt","content":"hello world"}}</tool_call>' },
      { role: 'user', content: 'Create a file test.txt with content "hello world"' },
    ]);
    expect(response).toContain('<tool_call>');
    expect(response).toContain('write_file');
  }, 30000);

  it('handles context with previous messages', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'Answer briefly.' },
      { role: 'user', content: 'My name is Alice.' },
      { role: 'assistant', content: 'Nice to meet you, Alice!' },
      { role: 'user', content: 'What is my name?' },
    ]);
    expect(response).toMatch(/Alice/i);
  }, 30000);

  it('generates plan format', async () => {
    if (!(await isAvailable())) return;
    const response = await chat([
      { role: 'system', content: 'When given a complex task, create a plan using this format:\nplan create ProjectName step1-desc step2-desc step3-desc\nThen mark step1 as in_progress.' },
      { role: 'user', content: 'Create a REST API blog' },
    ]);
    expect(response.toLowerCase()).toContain('plan');
  }, 30000);
});
