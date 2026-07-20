import { join } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, IGNORE_DIRS, normalizePath, readDirEntries } from './path-utils.js';
import { fsError, fsOk, MAX_OUTPUT_CHARS } from './types.js';

/**
 * Инструмент отображения дерева директорий.
 * Показывает структуру файлов с ограничением глубины.
 *
 * @module tools/fs/tree
 */

export const treeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'tree',
    description: 'Show directory tree structure with depth limit.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: project root)' },
        depth: { type: 'number', description: 'Max depth (default: 3)' },
        max_files: { type: 'number', description: 'Max files to show (default: 200)' },
      },
    },
  },
};

/** Рекурсивно строит дерево директорий */
function buildTree(
  dir: string,
  baseDir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  counter: { count: number },
  maxFiles: number,
): string[] {
  if (depth > maxDepth || counter.count >= maxFiles) return [];

  const lines: string[] = [];
  const entries = readDirEntries(dir);

  const sorted = entries
    .filter(e => {
      const name = String(e.name);
      return !IGNORE_DIRS.has(name) && !name.startsWith('.');
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

  for (let i = 0; i < sorted.length; i++) {
    if (counter.count >= maxFiles) break;

    const entry = sorted[i];
    const name = String(entry.name);
    const isLast = i === sorted.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const fullPath = join(dir, name);

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${name}/`);
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      counter.count++;
      lines.push(...buildTree(fullPath, baseDir, childPrefix, depth + 1, maxDepth, counter, maxFiles));
    } else {
      lines.push(`${prefix}${connector}${name}`);
      counter.count++;
    }
  }

  return lines;
}

export function handleTree(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const rawPath = String(args.path ?? '.');
  const maxDepth = Math.min(10, Math.max(1, Number(args.depth ?? 3)));
  const maxFiles = Math.min(500, Math.max(10, Number(args.max_files ?? 200)));

  const resolved = resolvePath(rawPath, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const dirName = rawPath === '.' ? '.' : rawPath;
  const lines = [`${dirName}/`];
  const counter = { count: 0 };

  lines.push(...buildTree(resolved.abs, resolved.abs, '', 0, maxDepth, counter, maxFiles));

  if (counter.count >= maxFiles) {
    lines.push(`\n... (truncated at ${maxFiles} files)`);
  }

  const output = lines.join('\n');
  if (output.length > MAX_OUTPUT_CHARS) {
    return fsOk(output.slice(0, MAX_OUTPUT_CHARS) + `\n... (truncated)`, true);
  }

  return fsOk(output, counter.count >= maxFiles);
}

export const treeHandler: ToolHandler = {
  name: 'tree',
  definition: treeDefinition,
  async execute(args, ctx) {
    return handleTree(args, ctx.cwd);
  },
};
