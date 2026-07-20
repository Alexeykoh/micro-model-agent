import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../src/agent/tool-executor.js';
import type { ToolHandler, ToolResult, ToolContext } from '../src/tools/types.js';

// Mock hooks — в тестах нет .mma/hooks.json, хуки всегда разрешают
vi.mock('../src/tools/hooks.js', () => ({
  runPreToolUseHooks: () => ({ continue: true }),
  runPostToolUseHooks: () => ({ continue: true }),
}));

// Mock indexer — не вызываем реальный notifyFileChanged
vi.mock('../src/indexer/cache.js', () => ({
  notifyFileChanged: vi.fn(),
}));

// Mock system prompt cache
vi.mock('../src/agent/system-prompt.js', () => ({
  invalidateSystemPromptCache: vi.fn(),
}));

function createTestHandler(name: string, result: ToolResult): ToolHandler {
  return {
    name,
    definition: {
      type: 'function',
      function: {
        name,
        description: `Test tool: ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    execute: async () => result,
  };
}

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: '/tmp/test', ...overrides };
}

describe('ToolExecutor', () => {
  let executor: ToolExecutor;

  beforeEach(() => {
    executor = new ToolExecutor();
  });

  describe('registration', () => {
    it('registeradds a handler', () => {
      const handler = createTestHandler('test_tool', { stdout: 'ok', stderr: '', exitCode: 0, truncated: false });
      executor.register(handler);
      expect(executor.has('test_tool')).toBe(true);
      expect(executor.get('test_tool')).toBe(handler);
    });

    it('registerAll adds multiple handlers', () => {
      const h1 = createTestHandler('tool_a', { stdout: 'a', stderr: '', exitCode: 0, truncated: false });
      const h2 = createTestHandler('tool_b', { stdout: 'b', stderr: '', exitCode: 0, truncated: false });
      executor.registerAll([h1, h2]);
      expect(executor.has('tool_a')).toBe(true);
      expect(executor.has('tool_b')).toBe(true);
    });

    it('getDefinitions returns all definitions', () => {
      const h1 = createTestHandler('tool_a', { stdout: '', stderr: '', exitCode: 0, truncated: false });
      const h2 = createTestHandler('tool_b', { stdout: '', stderr: '', exitCode: 0, truncated: false });
      executor.registerAll([h1, h2]);
      const defs = executor.getDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map(d => d.function.name)).toContain('tool_a');
      expect(defs.map(d => d.function.name)).toContain('tool_b');
    });

    it('has returns false for unknown tool', () => {
      expect(executor.has('nonexistent')).toBe(false);
    });

    it('get returns undefined for unknown tool', () => {
      expect(executor.get('nonexistent')).toBeUndefined();
    });
  });

  describe('execution', () => {
    it('executes a registered handler', async () => {
      const handler = createTestHandler('echo', { stdout: 'hello', stderr: '', exitCode: 0, truncated: false });
      executor.register(handler);
      const { result } = await executor.execute(
        { id: '1', name: 'echo', arguments: {} },
        createCtx(),
        'echo',
      );
      expect(result.stdout).toBe('hello');
      expect(result.exitCode).toBe(0);
    });

    it('returns error for unknown tool', async () => {
      const { result } = await executor.execute(
        { id: '1', name: 'unknown', arguments: {} },
        createCtx(),
        'unknown',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unknown tool');
    });

    it('catches handler errors', async () => {
      const handler: ToolHandler = {
        name: 'crasher',
        definition: {
          type: 'function',
          function: { name: 'crasher', description: '', parameters: {} },
        },
        execute: async () => { throw new Error('boom'); },
      };
      executor.register(handler);
      const { result } = await executor.execute(
        { id: '1', name: 'crasher', arguments: {} },
        createCtx(),
        'crasher',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Tool error: boom');
    });

    it('returns elapsed time', async () => {
      const handler = createTestHandler('fast', { stdout: '', stderr: '', exitCode: 0, truncated: false });
      executor.register(handler);
      const { elapsed } = await executor.execute(
        { id: '1', name: 'fast', arguments: {} },
        createCtx(),
        'fast',
      );
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(typeof elapsed).toBe('number');
    });
  });

  describe('truncation', () => {
    it('truncates long stdout for read_file', async () => {
      const longOutput = 'x'.repeat(3000);
      const handler = createTestHandler('read_file', { stdout: longOutput, stderr: '', exitCode: 0, truncated: false });
      executor.register(handler);
      const { result } = await executor.execute(
        { id: '1', name: 'read_file', arguments: {} },
        createCtx(),
        'read_file',
      );
      expect(result.stdout.length).toBeLessThan(3000);
      expect(result.stdout).toContain('[truncated]');
      expect(result.truncated).toBe(true);
    });

    it('truncates long stderr for errors', async () => {
      const longError = 'e'.repeat(5000);
      const handler = createTestHandler('bash', { stdout: '', stderr: longError, exitCode: 1, truncated: false });
      executor.register(handler);
      const { result } = await executor.execute(
        { id: '1', name: 'bash', arguments: {} },
        createCtx(),
        'bash',
      );
      expect(result.stderr.length).toBeLessThanOrEqual(3000 + 20);
      expect(result.stderr).toContain('[truncated]');
    });

    it('does not truncate short output', async () => {
      const handler = createTestHandler('read_file', { stdout: 'short', stderr: '', exitCode: 0, truncated: false });
      executor.register(handler);
      const { result } = await executor.execute(
        { id: '1', name: 'read_file', arguments: {} },
        createCtx(),
        'read_file',
      );
      expect(result.stdout).toBe('short');
      expect(result.truncated).toBe(false);
    });

    it('uses correct limit per tool', async () => {
      // write_file limit is 200
      const output200 = 'x'.repeat(200);
      const handler = createTestHandler('write_file', { stdout: output200, stderr: '', exitCode: 0, truncated: false });
      executor.register(handler);
      const { result } = await executor.execute(
        { id: '1', name: 'write_file', arguments: {} },
        createCtx(),
        'write_file',
      );
      expect(result.stdout).toBe(output200); // exactly at limit, not truncated

      // 201 chars should truncate
      const handler2 = createTestHandler('write_file', { stdout: 'x'.repeat(201), stderr: '', exitCode: 0, truncated: false });
      executor.register(handler2);
      const { result: result2 } = await executor.execute(
        { id: '2', name: 'write_file', arguments: {} },
        createCtx(),
        'write_file',
      );
      expect(result2.stdout).toContain('[truncated]');
    });
  });
});
