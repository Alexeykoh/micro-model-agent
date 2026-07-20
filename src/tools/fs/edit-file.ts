import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, assertExists, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

/**
 * Инструмент редактирования файла (find & replace).
 * Точное строковое совпадение (не regex).
 * Ошибка если old_string не найден или найден несколько раз
 * (если не указан replace_all).
 *
 * @module tools/fs/edit-file
 */

export const editFileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Find and replace text in a file. Use exact string matching (not regex). Fails if old_string not found or found multiple times (unless replace_all=true).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to project root)' },
        old_string: { type: 'string', description: 'Exact text to find (must match exactly)' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
};

export function handleEditFile(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const path = String(args.path ?? '');
  const oldString = String(args.old_string ?? '');
  const newString = String(args.new_string ?? '');
  const replaceAll = Boolean(args.replace_all);

  if (!path) return fsError('path is required. Usage: {"name":"edit_file","arguments":{"path":"file.ts","old_string":"old","new_string":"new"}}');
  if (!oldString) return fsError('old_string is required');
  if (newString === '' && !args.hasOwnProperty('new_string')) return fsError('new_string is required (use empty string "" to delete text)');

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

  if (!content.includes(oldString)) {
    const preview = oldString.length > 80 ? oldString.slice(0, 80) + '...' : oldString;
    return fsError(`old_string not found in file. Text: "${preview}"`);
  }

  if (replaceAll) {
    const count = content.split(oldString).length - 1;
    content = content.split(oldString).join(newString);
    return writeAndReport(resolved.abs, content, path, count, 'Replaced');
  }

  const idx = content.indexOf(oldString);
  const afterFirst = content.indexOf(oldString, idx + oldString.length);
  if (afterFirst !== -1) {
    return fsError(`old_string found multiple times. Use replace_all: true to replace all, or provide a more specific old_string.`);
  }

  content = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  return writeAndReport(resolved.abs, content, path, 1, 'Replaced');
}

function writeAndReport(
  absPath: string,
  content: string,
  relPath: string,
  count: number,
  verb: string,
): ReturnType<typeof fsOk> {
  const tmpPath = absPath + '.mma.tmp';
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    if (existsSync(absPath)) unlinkSync(absPath);
    renameSync(tmpPath, absPath);
  } catch (e: any) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    return fsError(`Write failed: ${e.message}`);
  }

  return fsOk(`${verb} ${count} occurrence(s) in ${normalizePath(relPath)}`);
}

export const editFileHandler: ToolHandler = {
  name: 'edit_file',
  definition: editFileDefinition,
  async execute(args, ctx) {
    return handleEditFile(args, ctx.cwd);
  },
};
