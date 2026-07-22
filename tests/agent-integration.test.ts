import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LMStudioNative } from '../src/llm/lmstudio-native.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import { clearPlan } from '../src/tools/plan.js';
import type { OutputRenderer } from '../src/ui/renderer.js';
import type { StatusInfo } from '../src/ui/renderer.js';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.MMA_LLM_URL || 'http://localhost:1234/v1';
const MODEL = process.env.MMA_LLM_MODEL || 'qwen/qwen3.5-9b';
const CTX = parseInt(process.env.MMA_CTX || '32768', 10);

let provider: LMStudioNative;

beforeAll(() => {
  provider = new LMStudioNative(BASE_URL, MODEL, CTX);
  clearPlan();
});

afterAll(() => {
  clearPlan();
});

async function isAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const mockRenderer: OutputRenderer = {
  write() {},
  writeLine() {},
  writeNewline() {},
  writeInfo() {},
  writeSuccess() {},
  writeWarning() {},
  writeError() {},
  writeDim() {},
  writeBracketTag() {},
  writeHeading() {},
  writeToolHeader() {},
  writeToolPreview() {},
  writeToolResult() {},
  writeMarkdownChunk() {},
  commitMarkdown() {},
  writeSpinner() {},
  clearSpinner() {},
  updateContextUsage() {},
  updateStatus(_i: StatusInfo) {},
  async prompt() { return ''; },
  writeFileOutput() {},
  destroy() {},
};

const cwd = process.cwd();

function cleanup(...files: string[]) {
  for (const f of files) {
    const p = join(cwd, f);
    if (existsSync(p)) rmSync(p, { recursive: true });
  }
}

describe('Agent loop integration', () => {
  it('responds to simple question', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    const result = await runAgentLoop(
      provider, registry,
      'What is the capital of France? Answer in one word.',
      undefined, undefined, mockRenderer, 'test', { quiet: true },
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg).toBeDefined();
    expect(lastMsg.content.toLowerCase()).toContain('paris');
  }, 60000);

  it('uses bash tool', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    const result = await runAgentLoop(
      provider, registry,
      'Run this command: echo "integration-ok"',
      undefined, undefined, mockRenderer, 'test', { quiet: true },
    );
    const toolCalls = result.messages.filter(m => m.role === 'tool');
    expect(toolCalls.length).toBeGreaterThan(0);
  }, 60000);

  it('creates a file via write_file tool', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    await runAgentLoop(
      provider, registry,
      'Create a file called test-integration-hello.txt with content "Hello from MMA integration test"',
      undefined, undefined, mockRenderer, 'test', { quiet: true },
    );
    const filePath = join(cwd, 'test-integration-hello.txt');
    expect(existsSync(filePath)).toBe(true);
    cleanup('test-integration-hello.txt');
  }, 90000);

  it('creates directory and file', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    await runAgentLoop(
      provider, registry,
      'Create a directory mma-integration-test-dir and create a file info.txt inside it with content "test"',
      undefined, undefined, mockRenderer, 'test', { quiet: true },
    );
    expect(existsSync(join(cwd, 'mma-integration-test-dir'))).toBe(true);
    expect(existsSync(join(cwd, 'mma-integration-test-dir', 'info.txt'))).toBe(true);
    cleanup('mma-integration-test-dir');
  }, 90000);

  it('handles multi-step task', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    await runAgentLoop(
      provider, registry,
      'Create 3 files: multi-a.txt, multi-b.txt, multi-c.txt. Each with content "A", "B", "C" respectively.',
      undefined, undefined, mockRenderer, 'test', { quiet: true },
    );
    const a = existsSync(join(cwd, 'multi-a.txt'));
    const b = existsSync(join(cwd, 'multi-b.txt'));
    const c = existsSync(join(cwd, 'multi-c.txt'));
    expect(a || b || c).toBe(true);
    cleanup('multi-a.txt', 'multi-b.txt', 'multi-c.txt');
  }, 120000);

  it('fast mode prompt has no skills', async () => {
    if (!(await isAvailable())) return;
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('Available Skills');
    expect(prompt).toContain('Mode: Fast');
  });

  it('pro mode prompt has grill-me instruction', async () => {
    if (!(await isAvailable())) return;
    const prompt = buildSystemPrompt(undefined, 'pro');
    expect(prompt).toContain('Mode: Pro');
    expect(prompt).toContain('grill-me');
  });

  it('model responds in fast mode', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    const result = await runAgentLoop(
      provider, registry,
      'What is 2+2? Answer in one word.',
      undefined, undefined, mockRenderer, 'test',
      { quiet: true, mode: 'fast' },
    );
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg).toBeDefined();
    expect(lastMsg.content.toLowerCase()).toContain('4');
  }, 60000);

  it('uses web_search tool', async () => {
    if (!(await isAvailable())) return;
    const registry = new ToolRegistry();
    const result = await runAgentLoop(
      provider, registry,
      'Use the web_search tool to search for "weather Minsk today". Return the tool output.',
      undefined, undefined, mockRenderer, 'test', { quiet: true },
    );
    const toolCalls = result.messages.filter(m => m.role === 'tool');
    // Model should have called web_search — tool output is either results or "No results found."
    expect(toolCalls.length).toBeGreaterThan(0);
  }, 90000);
});
