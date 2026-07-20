import { renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, assertExists, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

/**
 * Инструмент переменования/переименования файлов.
 * Создаёт родительские директории автоматически.
 *
 * @module tools/fs/move-file
 */

export const moveFileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'move_file',
    description: 'Move or rename a file.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source file path' },
        destination: { type: 'string', description: 'Destination file path' },
      },
      required: ['source', 'destination'],
    },
  },
};

export function handleMoveFile(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const source = String(args.source ?? '');
  const dest = String(args.destination ?? '');

  const srcResolved = resolvePath(source, cwd);
  if (!srcResolved.ok) return fsError(`Source: ${srcResolved.error}`);

  const srcExists = assertExists(srcResolved.abs);
  if (!srcExists.ok) return fsError(srcExists.error);

  const dstResolved = resolvePath(dest, cwd);
  if (!dstResolved.ok) return fsError(`Destination: ${dstResolved.error}`);

  try {
    mkdirSync(dirname(dstResolved.abs), { recursive: true });
    renameSync(srcResolved.abs, dstResolved.abs);
  } catch (e: any) {
    return fsError(`Move failed: ${e.message}`);
  }

  return fsOk(`Moved ${normalizePath(source)} → ${normalizePath(dest)}`);
}

export const moveFileHandler: ToolHandler = {
  name: 'move_file',
  definition: moveFileDefinition,
  async execute(args, ctx) {
    return handleMoveFile(args, ctx.cwd);
  },
};
