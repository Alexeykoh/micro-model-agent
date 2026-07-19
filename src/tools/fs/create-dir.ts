import { mkdirSync } from 'node:fs';
import type { ToolDefinition } from '../registry.js';
import { resolvePath, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

/**
 * Инструмент создания директорий.
 * Создаёт одну или несколько директорий по указанному пути.
 *
 * @module tools/fs/create-dir
 */

export const createDirDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'create_dir',
    description: 'Create a directory (and parent directories if needed).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create' },
      },
      required: ['path'],
    },
  },
};

export function handleCreateDir(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const path = String(args.path ?? '');
  const resolved = resolvePath(path, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  try {
    mkdirSync(resolved.abs, { recursive: true });
  } catch (e: any) {
    return fsError(`Cannot create directory: ${e.message}`);
  }

  return fsOk(`Created directory: ${normalizePath(path)}`);
}
