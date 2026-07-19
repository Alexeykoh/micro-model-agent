import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import { resolvePath, formatSize, normalizePath, readDirEntries } from './path-utils.js';
import { fsError, fsOk, MAX_OUTPUT_CHARS } from './types.js';

/**
 * Инструмент просмотра содержимого директории.
 * Показывает размеры и типы файлов/папок.
 *
 * @module tools/fs/list-dir
 */

export const listDirDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List directory contents with sizes and type indicators.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: current directory)' },
        show_hidden: { type: 'boolean', description: 'Show hidden files (default: false)' },
      },
    },
  },
};

export function handleListDir(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const rawPath = String(args.path ?? '.');
  const showHidden = Boolean(args.show_hidden);

  const resolved = resolvePath(rawPath, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const entries = readDirEntries(resolved.abs);
  if (entries.length === 0 && !resolved.abs) {
    return fsError(`Cannot list directory: ${resolved.abs}`);
  }

  const lines: string[] = [];

  const sorted = entries
    .filter(e => showHidden || !String(e.name).startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

  for (const entry of sorted) {
    const name = String(entry.name);
    const fullPath = join(resolved.abs, name);
    const isDir = entry.isDirectory();

    try {
      const stat = statSync(fullPath);
      const size = isDir ? '' : `  ${formatSize(Number(stat.size))}`;
      const icon = isDir ? 'd' : '-';
      lines.push(`${icon}  ${name}${isDir ? '/' : ''}${size}`);
    } catch {
      lines.push(`?  ${name}`);
    }
  }

  if (lines.length === 0) {
    return fsOk(`(empty directory) ${normalizePath(rawPath)}`);
  }

  const header = `${normalizePath(rawPath)}/ (${lines.length} entries)`;
  const result = header + '\n' + lines.join('\n');

  if (result.length > MAX_OUTPUT_CHARS) {
    return fsOk(result.slice(0, MAX_OUTPUT_CHARS) + `\n... (${lines.length} entries total)`, true);
  }

  return fsOk(result);
}
