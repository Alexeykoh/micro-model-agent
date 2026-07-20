import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, assertExists, formatSize, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

/**
 * Инструмент получения метаданных файла/директории.
 * Показывает размер, даты создания/изменения, права доступа.
 *
 * @module tools/fs/file-info
 */

export const fileInfoDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_info',
    description: 'Get file/directory metadata: size, dates, permissions.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path' },
      },
      required: ['path'],
    },
  },
};

export function handleFileInfo(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const path = String(args.path ?? '');
  const resolved = resolvePath(path, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const exists = assertExists(resolved.abs);
  if (!exists.ok) return fsError(exists.error);

  const s = exists.stat!;
  const info = [
    `Path: ${normalizePath(path)}`,
    `Type: ${s.isDirectory() ? 'directory' : 'file'}`,
    `Size: ${formatSize(Number(s.size))}`,
    `Created:  ${s.birthtime.toISOString()}`,
    `Modified: ${s.mtime.toISOString()}`,
    `Accessed: ${s.atime.toISOString()}`,
    `Mode: ${s.mode.toString(8)}`,
  ];

  return fsOk(info.join('\n'));
}

export const fileInfoHandler: ToolHandler = {
  name: 'file_info',
  definition: fileInfoDefinition,
  async execute(args, ctx) {
    return handleFileInfo(args, ctx.cwd);
  },
};
