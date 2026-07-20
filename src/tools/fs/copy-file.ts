import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, assertExists, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

/**
 * Инструмент копирования файлов.
 * Создаёт родительские директории автоматически.
 *
 * @module tools/fs/copy-file
 */

export const copyFileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'copy_file',
    description: 'Copy a file to a new location.',
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

export function handleCopyFile(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const source = String(args.source ?? '');
  const dest = String(args.destination ?? '');

  const srcResolved = resolvePath(source, cwd);
  if (!srcResolved.ok) return fsError(`Source: ${srcResolved.error}`);

  const srcExists = assertExists(srcResolved.abs, 'file');
  if (!srcExists.ok) return fsError(srcExists.error);

  const dstResolved = resolvePath(dest, cwd);
  if (!dstResolved.ok) return fsError(`Destination: ${dstResolved.error}`);

  try {
    mkdirSync(dirname(dstResolved.abs), { recursive: true });
    copyFileSync(srcResolved.abs, dstResolved.abs);
  } catch (e: any) {
    return fsError(`Copy failed: ${e.message}`);
  }

  return fsOk(`Copied ${normalizePath(source)} → ${normalizePath(dest)}`);
}

export const copyFileHandler: ToolHandler = {
  name: 'copy_file',
  definition: copyFileDefinition,
  async execute(args, ctx) {
    return handleCopyFile(args, ctx.cwd);
  },
};
