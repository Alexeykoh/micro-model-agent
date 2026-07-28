import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../src/agent/tool-executor.js';
import type { ToolHandler, ToolResult, ToolContext } from '../src/tools/types.js';

// Mock hooks — в тестах нет .mma/hooks.json, хуки всегда разрешают
vi.mock('../src/tools/hooks.js', () => ({
  runPreToolUseHooks: () => ({ continue: true }),
  runPostToolUseHooks: () => ({ continue: true }),
}));

// Mock grounding config для pre-flight тестов
const mockGetGroundingConfig = vi.fn(() => ({
  enabled: true,
  strictMode: false,
  checkFiles: true,
  maxMissingGrounding: 3,
}));

vi.mock('../src/config/config.js', () => ({
  getGroundingConfig: mockGetGroundingConfig,
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

  describe('path-not-found enrichment', () => {
    it('appends parent directory listing on path-not-found error', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();

      // Handler that returns "path not found" error
      const failingHandler = createTestHandler('read_file', {
        stdout: '', stderr: "Cannot find path 'E:\\foo\\bar.ts' because it does not exist.", exitCode: 1, truncated: false,
      });
      executor.register(failingHandler);

      // list_dir handler that returns directory contents
      const listDirHandler = createTestHandler('list_dir', {
        stdout: 'file1.ts\nfile2.ts', stderr: '', exitCode: 0, truncated: false,
      });
      executor.register(listDirHandler);

      const { result } = await executor.execute(
        { id: '1', name: 'read_file', arguments: { path: 'E:\\foo\\bar.ts' } },
        ctx, 'read_file',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ENOENT');
      expect(result.stderr).toContain('does not exist');
    });

    it('does not enrich non-path errors', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();

      const handler = createTestHandler('bash', {
        stdout: '', stderr: 'npm ERR! code ENOENT', exitCode: 1, truncated: false,
      });
      executor.register(handler);

      const { result } = await executor.execute(
        { id: '1', name: 'bash', arguments: { cmd: 'npm test' } },
        ctx, 'bash',
      );
      expect(result.stderr).not.toContain('[ENRICHMENT]');
    });
  });

  describe('pre-flight path validation', () => {
    it('blocks read_file with non-existent path', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('read_file', { stdout: 'content', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'read_file', arguments: { path: 'E:\\nonexistent\\file.ts' } },
        ctx, 'read_file',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ENOENT');
      expect(result.stderr).toContain('does not exist');
    });

    it('blocks write_file with non-existent parent dir', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('write_file', { stdout: 'ok', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'write_file', arguments: { path: 'E:\\no_such_dir\\file.ts', content: 'x' } },
        ctx, 'write_file',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('parent directory');
      expect(result.stderr).toContain('does not exist');
    });

    it('allows write_file when parent dir exists', async () => {
      // Use real temp dir as existing parent
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const testPath = join(tmpdir(), '__mma_preflight_test_write__');

      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('write_file', { stdout: 'written', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'write_file', arguments: { path: testPath, content: 'x' } },
        ctx, 'write_file',
      );
      // Should pass pre-flight and reach the handler
      expect(result.stdout).toBe('written');
      expect(result.exitCode).toBe(0);
    });

    it('blocks copy_file with non-existent source', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('copy_file', { stdout: 'copied', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'copy_file', arguments: { source: 'E:\\no_src\\file.ts', destination: 'E:\\dest\\file.ts' } },
        ctx, 'copy_file',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ENOENT');
      expect(result.stderr).toContain('source path not found');
    });

    it('blocks copy_file with non-existent destination parent', async () => {
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const existingSource = join(tmpdir(), '__mma_cp_src__');
      const { writeFileSync, existsSync } = await import('node:fs');
      if (!existsSync(existingSource)) {
        writeFileSync(existingSource, 'test', 'utf-8');
      }

      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('copy_file', { stdout: 'copied', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'copy_file', arguments: { source: existingSource, destination: 'E:\\no_such_dir\\dest.ts' } },
        ctx, 'copy_file',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('parent directory of destination');
    });

    it('blocks create_dir with non-existent parent', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('create_dir', { stdout: 'created', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'create_dir', arguments: { path: 'E:\\no_parent\\subdir' } },
        ctx, 'create_dir',
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('parent directory');
    });

    it('skips pre-flight for non-FS tools (bash)', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('bash', { stdout: 'ok', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'bash', arguments: { cmd: 'echo hello' } },
        ctx, 'echo hello',
      );
      expect(result.stdout).toBe('ok');
      expect(result.exitCode).toBe(0);
    });

    it('skips pre-flight when checkFiles is disabled', async () => {
      mockGetGroundingConfig.mockReturnValueOnce({
        enabled: true,
        strictMode: false,
        checkFiles: false,
        maxMissingGrounding: 3,
      });

      const executor = new ToolExecutor();
      const ctx = createCtx();
      executor.register(createTestHandler('read_file', { stdout: 'content', stderr: '', exitCode: 0, truncated: false }));

      const { result } = await executor.execute(
        { id: '1', name: 'read_file', arguments: { path: 'E:\\nonexistent\\file.ts' } },
        ctx, 'read_file',
      );
      // Should pass through to handler even though path doesn't exist
      expect(result.stdout).toBe('content');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('error pattern detection', () => {
    it('adds HINT on 2nd same error', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      const handler = createTestHandler('bash', {
        stdout: '', stderr: 'permission denied: /tmp/test', exitCode: 1, truncated: false,
      });
      executor.register(handler);

      // First error — no hint
      const r1 = await executor.execute({ id: '1', name: 'bash', arguments: { cmd: 'rm' } }, ctx, 'bash');
      expect(r1.result.stderr).not.toContain('[HINT]');
      // Second error — HINT
      const r2 = await executor.execute({ id: '2', name: 'bash', arguments: { cmd: 'rm' } }, ctx, 'bash');
      expect(r2.result.stderr).toContain('[HINT]');
      expect(r2.result.stderr).toContain('2 times');
    });

    it('adds WARNING on 3rd same error', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      const handler = createTestHandler('bash', {
        stdout: '', stderr: 'permission denied: /tmp/test', exitCode: 1, truncated: false,
      });
      executor.register(handler);

      await executor.execute({ id: '1', name: 'bash', arguments: { cmd: 'rm' } }, ctx, 'bash');
      await executor.execute({ id: '2', name: 'bash', arguments: { cmd: 'rm' } }, ctx, 'bash');
      const r3 = await executor.execute({ id: '3', name: 'bash', arguments: { cmd: 'rm' } }, ctx, 'bash');
      expect(r3.result.stderr).toContain('[WARNING]');
      expect(r3.result.stderr).toContain('3 times');
    });

    it('resets error count on success', async () => {
      const executor = new ToolExecutor();
      const ctx = createCtx();
      const failHandler = createTestHandler('bash', {
        stdout: '', stderr: 'error occurred', exitCode: 1, truncated: false,
      });
      const okHandler = createTestHandler('bash', {
        stdout: 'ok', stderr: '', exitCode: 0, truncated: false,
      });
      executor.register(failHandler);

      // Error twice
      await executor.execute({ id: '1', name: 'bash', arguments: { cmd: 'fail' } }, ctx, 'bash');
      await executor.execute({ id: '2', name: 'bash', arguments: { cmd: 'fail' } }, ctx, 'bash');

      // Success — should reset
      executor.register(okHandler);
      await executor.execute({ id: '3', name: 'bash', arguments: { cmd: 'ok' } }, ctx, 'bash');

      // New error — should start fresh (no HINT)
      executor.register(failHandler);
      const r4 = await executor.execute({ id: '4', name: 'bash', arguments: { cmd: 'fail' } }, ctx, 'bash');
      expect(r4.result.stderr).not.toContain('[HINT]');
    });
  });
});
