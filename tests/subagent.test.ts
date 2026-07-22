import { describe, it, expect } from 'vitest';
import { extractAllToolCalls, validateToolCall, buildSubagentContext, buildSpecialistTask, isTrivialError, subagentDefinition } from '../src/tools/subagent.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── extractAllToolCalls ──────────────────────────────────

describe('extractAllToolCalls', () => {

  it('extracts single valid tool call', () => {
    const input = 'Some text <tool_call>{"name":"read_file","arguments":{"path":"test.ts"}}</tool_call> and more';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"read_file","arguments":{"path":"test.ts"}}');
  });

  it('extracts multiple tool calls', () => {
    const input = '<tool_call>{"name":"a","arguments":{}}</tool_call><tool_call>{"name":"b","arguments":{}}</tool_call>';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(2);
  });

  it('handles tool call with markdown fences', () => {
    const input = '<tool_call>```json\n{"name":"bash","arguments":{"cmd":"ls"}}\n```</tool_call>';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"bash","arguments":{"cmd":"ls"}}');
  });

  it('returns empty array when no tool calls', () => {
    expect(extractAllToolCalls('just regular text')).toEqual([]);
  });

  it('handles unclosed tool_call tag', () => {
    const input = '<tool_call>{"name":"test","arguments":{}}';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"test","arguments":{}}');
  });

  it('handles escaped characters inside JSON', () => {
    const input = '<tool_call>{"name":"write_file","arguments":{"path":"file.ts","content":"console.log(\\"hello\\");"}}</tool_call>';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('console.log');
  });

  it('handles nested objects in tool call arguments', () => {
    const input = '<tool_call>{"name":"edit_file","arguments":{"path":"file.ts","old_string":"foo","new_string":"bar"}}</tool_call>';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.arguments.old_string).toBe('foo');
    expect(parsed.arguments.new_string).toBe('bar');
  });

  it('extracts only json content ignoring surrounding text', () => {
    const input = '<tool_call>prefix{"name":"test","arguments":{"x":1}}suffix</tool_call>';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"test","arguments":{"x":1}}');
  });

  it('extracts from multiple lines', () => {
    const input = `Start
<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>
middle
<tool_call>{"name":"write_file","arguments":{"path":"b.ts","content":"hi"}}</tool_call>
end`;
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('read_file');
    expect(result[1]).toContain('write_file');
  });

  it('extracts tool call with nested braces inside strings', () => {
    const input = '<tool_call>{"name":"write_file","arguments":{"path":"test.ts","content":"const x = { a: 1 };"}}</tool_call>';
    const result = extractAllToolCalls(input);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.arguments.content).toBe('const x = { a: 1 };');
  });
});

// ─── validateToolCall ──────────────────────────────────────

describe('validateToolCall', () => {

  it('accepts valid tool call with all required args', () => {
    const result = validateToolCall({ name: 'write_file', arguments: { path: 'a.ts', content: 'x' } });
    expect(result.valid).toBe(true);
    expect(result.name).toBe('write_file');
  });

  it('rejects null input', () => {
    expect(validateToolCall(null).valid).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateToolCall('string').valid).toBe(false);
  });

  it('rejects unknown tool name', () => {
    const result = validateToolCall({ name: 'unknown_tool', arguments: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('rejects missing arguments', () => {
    const result = validateToolCall({ name: 'read_file', arguments: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing required');
    expect(result.error).toContain('path');
  });

  it('rejects empty required argument', () => {
    const result = validateToolCall({ name: 'write_file', arguments: { path: '', content: 'x' } });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('path');
  });

  it('accepts subagent with only task', () => {
    const result = validateToolCall({ name: 'subagent', arguments: { task: 'Create file' } });
    expect(result.valid).toBe(true);
  });

  it('accepts subagent with task and existingFiles', () => {
    const result = validateToolCall({ name: 'subagent', arguments: { task: 'Create file', existingFiles: 'a.ts' } });
    expect(result.valid).toBe(true);
  });

  it('accepts plan call', () => {
    const result = validateToolCall({ name: 'plan', arguments: { name: 'Plan', steps: ['a', 'b'] } });
    expect(result.valid).toBe(true);
  });

  it('rejects bash with empty cmd', () => {
    const result = validateToolCall({ name: 'bash', arguments: { cmd: '' } });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Empty command');
  });

  it('accepts bash with valid cmd', () => {
    const result = validateToolCall({ name: 'bash', arguments: { cmd: 'npm test' } });
    expect(result.valid).toBe(true);
    expect(result.cmd).toBe('npm test');
  });

  it('rejects grep_search without pattern', () => {
    const result = validateToolCall({ name: 'grep_search', arguments: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('pattern');
  });

  it('accepts user_profile without arguments', () => {
    const result = validateToolCall({ name: 'user_profile', arguments: {} });
    expect(result.valid).toBe(true);
  });

  it('rejects arguments that are wrong type (string instead of object)', () => {
    const result = validateToolCall({ name: 'bash', arguments: 'not-an-object' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing arguments');
  });
});

// ─── buildSubagentContext ──────────────────────────────────

describe('buildSubagentContext', () => {

  it('returns empty string for empty directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      const result = buildSubagentContext(dir);
      expect(result).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects src files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');
      writeFileSync(join(dir, 'src', 'util.ts'), 'export const y = 2;');
      const result = buildSubagentContext(dir);
      expect(result).toContain('Files in src/');
      expect(result).toContain('index.ts');
      expect(result).toContain('util.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects package.json dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'test',
        type: 'module',
        dependencies: { express: '^4.0', sqlite3: '^5.0' },
        devDependencies: { typescript: '^5.0' },
      }));
      const result = buildSubagentContext(dir);
      expect(result).toContain('Dependencies');
      expect(result).toContain('express');
      expect(result).toContain('sqlite3');
      expect(result).toContain('DevDependencies');
      expect(result).toContain('typescript');
      expect(result).toContain('Module type');
      expect(result).toContain('module');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects tsconfig.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      const result = buildSubagentContext(dir);
      expect(result).toContain('Has tsconfig.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles missing src directory gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      const result = buildSubagentContext(dir);
      expect(result).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('combines all context sources', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'main.ts'), 'const x = 1;');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test', dependencies: { react: '^18' } }));
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      const result = buildSubagentContext(dir);
      expect(result).toContain('Files in src/');
      expect(result).toContain('main.ts');
      expect(result).toContain('Dependencies');
      expect(result).toContain('react');
      expect(result).toContain('Has tsconfig.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters only .ts/.tsx/.js/.jsx files in src', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-test-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'app.ts'), '');
      writeFileSync(join(dir, 'src', 'component.tsx'), '');
      writeFileSync(join(dir, 'src', 'styles.css'), '');
      writeFileSync(join(dir, 'src', 'data.json'), '');
      const result = buildSubagentContext(dir);
      expect(result).toContain('app.ts');
      expect(result).toContain('component.tsx');
      expect(result).not.toContain('styles.css');
      expect(result).not.toContain('data.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── subagentDefinition ────────────────────────────────────

describe('subagentDefinition', () => {

  it('has correct type and name', () => {
    expect(subagentDefinition.type).toBe('function');
    expect(subagentDefinition.function.name).toBe('subagent');
  });

  it('has required task parameter', () => {
    const params = subagentDefinition.function.parameters as any;
    expect(params.required).toContain('task');
    expect(params.properties.task.type).toBe('string');
  });

  it('has optional existingFiles parameter', () => {
    const params = subagentDefinition.function.parameters as any;
    expect(params.properties.existingFiles.type).toBe('string');
    expect(params.required).not.toContain('existingFiles');
  });
});

// ─── buildSpecialistTask ────────────────────────────────────

describe('buildSpecialistTask', () => {

  it('includes tool name and error count', () => {
    const result = buildSpecialistTask('bash', { cmd: 'ls' }, 'permission denied', 'delete files', 2);
    expect(result).toContain('bash');
    expect(result).toContain('2 times');
    expect(result).toContain('permission denied');
  });

  it('includes tool arguments as JSON', () => {
    const args = { path: '/foo/bar', content: 'hello' };
    const result = buildSpecialistTask('write_file', args, 'file not found', 'write a file', 1);
    expect(result).toContain('/foo/bar');
    expect(result).toContain('write_file');
  });

  it('includes user task (truncated to 200 chars)', () => {
    const longTask = 'x'.repeat(100) + 'y'.repeat(200);
    const result = buildSpecialistTask('read_file', { path: 'x' }, 'error', longTask, 1);
    expect(result).toContain('x'.repeat(100) + 'y'.repeat(100));
    expect(result).not.toContain('y'.repeat(101) + 'y');
  });

  it('truncates error output to 500 chars', () => {
    const longError = 'x'.repeat(600);
    const result = buildSpecialistTask('bash', {}, longError, 'task', 1);
    expect(result).toContain('x'.repeat(500));
    expect(result).not.toContain('x'.repeat(501));
  });

  it('contains diagnostic instructions', () => {
    const result = buildSpecialistTask('bash', { cmd: 'rm' }, 'no such file', 'clean up', 3);
    expect(result).toContain('Diagnose WHY');
    expect(result).toContain('FIX the underlying problem');
    expect(result).toContain('root cause');
  });
});

// ─── isTrivialError ─────────────────────────────────────────

describe('isTrivialError', () => {

  it('returns true for grep 0 results', () => {
    expect(isTrivialError('grep_search', '0 results found for pattern "xyz"')).toBe(true);
  });

  it('returns true for glob 0 matches', () => {
    expect(isTrivialError('glob_search', '0 files matched')).toBe(true);
  });

  it('returns true for very short errors', () => {
    expect(isTrivialError('bash', 'err')).toBe(true);
  });

  it('returns false for path-not-found errors', () => {
    expect(isTrivialError('read_file', 'Cannot find path E:\\foo because it does not exist.')).toBe(false);
  });

  it('returns false for real bash errors', () => {
    expect(isTrivialError('bash', 'npm ERR! code ENOENT\nnpm ERR! enoent')).toBe(false);
  });

  it('returns false for write_file errors', () => {
    expect(isTrivialError('write_file', 'Permission denied: /etc/passwd')).toBe(false);
  });

  it('returns true for no results found pattern', () => {
    expect(isTrivialError('grep_search', 'no results found')).toBe(true);
  });

  // ── Non-trivial: syntax errors always require specialist ──

  it('returns false for Unexpected token (syntax error)', () => {
    expect(isTrivialError('bash', 'Unexpected token')).toBe(false);
  });

  it('returns false for SyntaxError', () => {
    expect(isTrivialError('write_file', 'SyntaxError: Unexpected token')).toBe(false);
  });

  it('returns false for cannot find module', () => {
    expect(isTrivialError('bash', "Cannot find module './App.tsx'")).toBe(false);
  });

  it('returns false for permission denied', () => {
    expect(isTrivialError('bash', 'Permission denied: /etc/passwd')).toBe(false);
  });

  it('returns false for ENOENT', () => {
    expect(isTrivialError('bash', 'ENOENT: no such file or directory')).toBe(false);
  });

  it('still returns true for grep 0 results despite short length', () => {
    expect(isTrivialError('grep_search', '0 results')).toBe(true);
  });
});
