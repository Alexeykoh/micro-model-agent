import { readFileSync } from 'node:fs';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, assertExists, truncateOutput, normalizePath } from './path-utils.js';
import { fsError, fsOk, MAX_OUTPUT_CHARS } from './types.js';

/**
 * Инструмент чтения файла с номерами строк.
 * Поддерживает offset/limit для больших файлов.
 *
 * @module tools/fs/read-file
 */

export const readFileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read file contents with line numbers. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to project root)' },
        offset: { type: 'number', description: 'Start line (1-indexed). Default 1.' },
        limit: { type: 'number', description: 'Max lines to read. Default 500.' },
      },
      required: ['path'],
    },
  },
};

export function handleReadFile(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const path = String(args.path ?? '');
  const offset = Math.max(1, Number(args.offset ?? 1));
  const limit = Math.min(1000, Math.max(1, Number(args.limit ?? 500)));

  const resolved = resolvePath(path, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const exists = assertExists(resolved.abs, 'file');
  if (!exists.ok) return fsError(exists.error);

  let content: string;
  try {
    content = readFileSync(resolved.abs, 'utf-8');
  } catch (e: any) {
    return fsError(`Cannot read file: ${e.message}`);
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = offset - 1;
  const end = Math.min(start + limit, totalLines);

  const selected = lines.slice(start, end);
  const numbered = selected.map((line, i) => `${start + i + 1}: ${line}`);
  const output = numbered.join('\n');

  const footer = end < totalLines
    ? `\n... (showing ${start + 1}-${end} of ${totalLines} lines)`
    : '';

  const result = output + footer;
  const { text, truncated } = truncateOutput(result, MAX_OUTPUT_CHARS);

  return fsOk(text, truncated);
}

export const readFileHandler: ToolHandler = {
  name: 'read_file',
  definition: readFileDefinition,
  async execute(args, ctx) {
    return handleReadFile(args, ctx.cwd);
  },
};
