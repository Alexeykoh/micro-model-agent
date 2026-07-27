import { describe, it, expect } from 'vitest';
import { extractAllToolCalls, parseToolCalls } from '../src/tools/parse-tool-call.js';

describe('extractAllToolCalls', () => {
  it('извлекает один tool call', () => {
    const response = 'prefix<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>suffix';
    const result = extractAllToolCalls(response);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"bash","arguments":{"cmd":"ls"}}');
  });

  it('извлекает несколько tool calls из одного ответа', () => {
    const response =
      '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' +
      '<tool_call>{"name":"write_file","arguments":{"path":"b.txt","content":"hi"}}</tool_call>';
    const result = extractAllToolCalls(response);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('{"name":"read_file","arguments":{"path":"a.txt"}}');
    expect(result[1]).toBe('{"name":"write_file","arguments":{"path":"b.txt","content":"hi"}}');
  });

  it('обрабатывает незакрытый </tool_call> тег', () => {
    const response = '<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}';
    const result = extractAllToolCalls(response);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"bash","arguments":{"cmd":"ls"}}');
  });

  it('обрабатывает вложенные скобки в JSON-строках', () => {
    const response =
      '<tool_call>{"name":"write_file","arguments":{"path":"test.txt","content":"{\\"key\\": \\"value with {braces}\\"}"}}</tool_call>';
    const result = extractAllToolCalls(response);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.name).toBe('write_file');
    expect(parsed.arguments.content).toBe('{"key": "value with {braces}"}');
  });

  it('возвращает пустой массив при отсутствии tool calls', () => {
    const result = extractAllToolCalls('просто текст без тегов');
    expect(result).toHaveLength(0);
  });

  it('удаляет markdown-разметку вокруг JSON', () => {
    const response = '<tool_call>```json\n{"name":"bash","arguments":{"cmd":"ls"}}\n```</tool_call>';
    const result = extractAllToolCalls(response);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"name":"bash","arguments":{"cmd":"ls"}}');
  });
});

describe('parseToolCalls', () => {
  it('возвращает валидный tool call', () => {
    const response = '<tool_call>{"name":"bash","arguments":{"cmd":"ls -la"}}</tool_call>';
    const result = parseToolCalls(response);
    expect(result.validCalls).toHaveLength(1);
    expect(result.invalidCalls).toHaveLength(0);
    expect(result.validCalls[0].parsed.name).toBe('bash');
    expect(result.validCalls[0].parsed.arguments).toEqual({ cmd: 'ls -la' });
    expect(result.validCalls[0].cmd).toBe('ls -la');
  });

  it('исправляет маловероятный JSON через jsonrepair', () => {
    const response = '<tool_call>{"name": "bash", "arguments": {"cmd": "ls"}}</tool_call>';
    const result = parseToolCalls(response);
    expect(result.validCalls).toHaveLength(1);
    expect(result.validCalls[0].parsed.name).toBe('bash');
  });

  it('возвращает пустые массивы при отсутствии tool calls', () => {
    const result = parseToolCalls('просто текст');
    expect(result.validCalls).toHaveLength(0);
    expect(result.invalidCalls).toHaveLength(0);
  });

  it('помещает неверное имя инструмента в invalidCalls', () => {
    const response = '<tool_call>{"name":"nonexistent_tool","arguments":{"cmd":"ls"}}</tool_call>';
    const result = parseToolCalls(response);
    expect(result.validCalls).toHaveLength(0);
    expect(result.invalidCalls).toHaveLength(1);
    expect(result.invalidCalls[0]).toContain('Unknown tool');
  });

  it('обрабатывает несколько вызовов, где один невалидный', () => {
    const response =
      '<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>' +
      '<tool_call>{"name":"bad_tool","arguments":{"cmd":"ls"}}</tool_call>';
    const result = parseToolCalls(response);
    expect(result.validCalls).toHaveLength(1);
    expect(result.validCalls[0].parsed.name).toBe('bash');
    expect(result.invalidCalls).toHaveLength(1);
    expect(result.invalidCalls[0]).toContain('Unknown tool');
  });

  it('пропускает непарсируемый JSON', () => {
    const response = '<tool_call>{invalid json here}}</tool_call>';
    const result = parseToolCalls(response);
    expect(result.validCalls).toHaveLength(0);
    expect(result.invalidCalls).toHaveLength(0);
  });
});
