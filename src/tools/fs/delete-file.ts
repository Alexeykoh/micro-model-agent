import { rmSync } from 'node:fs';
import type { ToolDefinition } from '../registry.js';
import { resolvePath, assertExists, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

export const deleteFileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Delete a file or directory. Directories require recursive: true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
        recursive: { type: 'boolean', description: 'Delete directories recursively (default: false)' },
      },
      required: ['path'],
    },
  },
};

export function handleDeleteFile(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const path = String(args.path ?? '');
  const recursive = Boolean(args.recursive);

  const resolved = resolvePath(path, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const exists = assertExists(resolved.abs);
  if (!exists.ok) return fsError(exists.error);

  if (exists.stat!.isDirectory() && !recursive) {
    return fsError(`Cannot delete directory without recursive: true. Use recursive: true for directories.`);
  }

  try {
    rmSync(resolved.abs, { recursive, force: true });
  } catch (e: any) {
    return fsError(`Delete failed: ${e.message}`);
  }

  return fsOk(`Deleted: ${normalizePath(path)}`);
}
