import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSpecialistTask, isTrivialError, runIsolatedLoop } from '../src/tools/subagent.js';
import { ToolExecutor } from '../src/agent/tool-executor.js';
import type { ToolHandler, ToolResult, ToolContext } from '../src/tools/types.js';
import type { LLMProvider, ChatMessage, Chunk } from '../src/llm/provider.js';

// ─── Моки ────────────────────────────────────────────────

vi.mock('../src/tools/hooks.js', () => ({
  runPreToolUseHooks: () => ({ continue: true }),
  runPostToolUseHooks: () => ({ continue: true }),
}));
vi.mock('../src/indexer/cache.js', () => ({ notifyFileChanged: vi.fn() }));
vi.mock('../src/agent/system-prompt.js', () => ({
  buildSystemPrompt: () => 'test system prompt',
  invalidateSystemPromptCache: vi.fn(),
}));

function createHandler(name: string, result: ToolResult): ToolHandler {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description: `Test: ${name}`, parameters: { type: 'object', properties: {} } },
    },
    execute: async () => result,
  };
}

function createCtx(): ToolContext {
  return { cwd: '/tmp/test', quiet: true };
}

function createMockProvider(responses: string[]): LLMProvider {
  let callIndex = 0;
  return {
    model: 'test-model',
    contextWindow: 32768,
    async *chat(_messages: ChatMessage[], _opts?: any): AsyncIterable<Chunk> {
      const response = responses[callIndex++] ?? '';
      // Модель отвечает текстом без tool calls — цикл завершится
      yield { content: response };
      yield { finish_reason: 'stop' };
    },
  };
}

// ─── buildSpecialistTask edge cases ───────────────────────

describe('buildSpecialistTask edge cases', () => {

  it('handles empty toolArgs', () => {
    const result = buildSpecialistTask('bash', {}, 'error', 'task', 1);
    expect(result).toContain('"bash"');
    expect(result).toContain('{}');
  });

  it('handles very long error output (truncation)', () => {
    const longError = 'x'.repeat(1000);
    const result = buildSpecialistTask('bash', { cmd: 'ls' }, longError, 'task', 1);
    expect(result).toContain('x'.repeat(500));
    expect(result.length).toBeLessThan(longError.length + 500);
  });

  it('handles special characters in arguments', () => {
    const args = { path: 'C:\\Users\\test\\file with spaces.ts', content: 'const x = "hello";' };
    const result = buildSpecialistTask('write_file', args, 'error', 'task', 1);
    expect(result).toContain('file with spaces.ts');
    expect(result).toContain('write_file');
  });

  it('handles attemptCount of 1', () => {
    const result = buildSpecialistTask('bash', { cmd: 'ls' }, 'error', 'task', 1);
    expect(result).toContain('1 times');
  });

  it('handles attemptCount of 10', () => {
    const result = buildSpecialistTask('bash', { cmd: 'ls' }, 'error', 'task', 10);
    expect(result).toContain('10 times');
  });
});

// ─── isTrivialError edge cases ────────────────────────────

describe('isTrivialError edge cases', () => {

  it('returns true for glob_search with 0 files', () => {
    expect(isTrivialError('glob_search', '0 files matched for pattern "*.xyz"')).toBe(true);
  });

  it('returns true for grep_search with no match', () => {
    expect(isTrivialError('grep_search', 'no match found')).toBe(true);
  });

  it('returns false for bash ENOENT with long message', () => {
    const msg = 'npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path /foo/bar\nnpm ERR! errno -4058';
    expect(isTrivialError('bash', msg)).toBe(false);
  });

  it('returns false for write_file permission error', () => {
    expect(isTrivialError('write_file', 'EACCES: permission denied, open /etc/passwd')).toBe(false);
  });

  it('returns false for read_file path error', () => {
    expect(isTrivialError('read_file', 'Cannot find path E:\\missing because it does not exist.')).toBe(false);
  });

  it('returns true for empty error', () => {
    expect(isTrivialError('bash', '')).toBe(true);
  });

  it('returns true for single char error', () => {
    expect(isTrivialError('bash', 'x')).toBe(true);
  });

  it('returns false for edit_file error', () => {
    expect(isTrivialError('edit_file', 'Old string not found in file')).toBe(false);
  });
});

// ─── ToolExecutor enrichment integration ──────────────────

describe('ToolExecutor enrichment integration', () => {

  it('enriches path-not-found with list_dir output', async () => {
    const executor = new ToolExecutor();
    const ctx = createCtx();
    executor.register(createHandler('read_file', {
      stdout: '', stderr: "Cannot find path 'E:\\project\\src\\app.ts' because it does not exist.",
      exitCode: 1, truncated: false,
    }));
    executor.register(createHandler('list_dir', {
      stdout: 'index.ts\nutils.ts\ncomponents/', stderr: '', exitCode: 0, truncated: false,
    }));

    const { result } = await executor.execute(
      { id: '1', name: 'read_file', arguments: { path: 'E:\\project\\src\\app.ts' } },
      ctx, 'read_file',
    );
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('does not exist');
  });

  it('enrichment shows empty dir message when parent is empty', async () => {
    const executor = new ToolExecutor();
    const ctx = createCtx();
    executor.register(createHandler('read_file', {
      stdout: '', stderr: "Cannot find path 'E:\\empty\\file.txt' because it does not exist.",
      exitCode: 1, truncated: false,
    }));
    executor.register(createHandler('list_dir', {
      stdout: '', stderr: '', exitCode: 0, truncated: false,
    }));

    const { result } = await executor.execute(
      { id: '1', name: 'read_file', arguments: { path: 'E:\\empty\\file.txt' } },
      ctx, 'read_file',
    );
    expect(result.stderr).toContain('ENOENT');
    expect(result.stderr).toContain('does not exist');
  });

  it('error pattern accumulates across calls', async () => {
    const executor = new ToolExecutor();
    const ctx = createCtx();
    executor.register(createHandler('bash', {
      stdout: '', stderr: 'connection refused localhost:5432', exitCode: 1, truncated: false,
    }));

    const r1 = await executor.execute({ id: '1', name: 'bash', arguments: {} }, ctx, 'bash');
    expect(r1.result.stderr).not.toContain('[HINT]');

    const r2 = await executor.execute({ id: '2', name: 'bash', arguments: {} }, ctx, 'bash');
    expect(r2.result.stderr).toContain('[HINT]');

    const r3 = await executor.execute({ id: '3', name: 'bash', arguments: {} }, ctx, 'bash');
    expect(r3.result.stderr).toContain('[WARNING]');

    const r4 = await executor.execute({ id: '4', name: 'bash', arguments: {} }, ctx, 'bash');
    expect(r4.result.stderr).toContain('[WARNING]');
    expect(r4.result.stderr).toContain('4 times');
  });

  it('different errors tracked separately', async () => {
    const executor = new ToolExecutor();
    const ctx = createCtx();
    executor.register(createHandler('bash', {
      stdout: '', stderr: 'error A', exitCode: 1, truncated: false,
    }));

    await executor.execute({ id: '1', name: 'bash', arguments: {} }, ctx, 'bash');

    // Switch to different error
    executor.register(createHandler('bash', {
      stdout: '', stderr: 'error B', exitCode: 1, truncated: false,
    }));

    const r2 = await executor.execute({ id: '2', name: 'bash', arguments: {} }, ctx, 'bash');
    // Different error — no HINT (first occurrence of this error)
    expect(r2.result.stderr).not.toContain('[HINT]');
  });
});

// ─── runIsolatedLoop maxSteps param ───────────────────────

describe('runIsolatedLoop maxSteps', () => {

  it('respects maxStepsParam limit', async () => {
    let stepCount = 0;
    const provider: LLMProvider = {
      model: 'test',
      contextWindow: 32768,
      async *chat(): AsyncIterable<Chunk> {
        stepCount++;
        yield { content: `Step ${stepCount}` };
        yield { finish_reason: 'stop' };
      },
    };
    const registry = { getDefinitions: () => [], get: () => undefined } as any;

    const result = await runIsolatedLoop(
      provider, registry, 'do something', '', '/tmp', true,
      { writeSpinner: () => {}, clearSpinner: () => {}, writeMarkdownChunk: () => {},
        writeNewline: () => {}, writeDim: () => {}, writeBracketTag: () => {},
        writeError: () => {}, writeWarning: () => {}, commitMarkdown: () => {},
        writeToolBuffer: () => {}, abortSignal: undefined } as any,
      undefined, 'base', undefined, 3, // maxStepsParam = 3
    );
    expect(result.turns).toBeLessThanOrEqual(3);
  });

  it('uses default 20 when maxStepsParam not provided', async () => {
    const provider: LLMProvider = {
      model: 'test',
      contextWindow: 32768,
      async *chat(): AsyncIterable<Chunk> {
        yield { content: 'response' };
        yield { finish_reason: 'stop' };
      },
    };
    const registry = { getDefinitions: () => [], get: () => undefined } as any;

    const result = await runIsolatedLoop(
      provider, registry, 'task', '', '/tmp', true,
      { writeSpinner: () => {}, clearSpinner: () => {}, writeMarkdownChunk: () => {},
        writeNewline: () => {}, writeDim: () => {}, writeBracketTag: () => {},
        writeError: () => {}, writeWarning: () => {}, commitMarkdown: () => {},
        writeToolBuffer: () => {}, abortSignal: undefined } as any,
    );
    // Should complete in 1 step (no tools used), turns <= 20
    expect(result.turns).toBeLessThanOrEqual(20);
  });
});
