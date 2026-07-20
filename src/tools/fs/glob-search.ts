import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { resolvePath, IGNORE_DIRS, normalizePath, readDirEntries } from './path-utils.js';
import { fsError, fsOk, MAX_OUTPUT_CHARS } from './types.js';

/**
 * Инструмент поиска файлов по glob-паттерну.
 * Поддерживает * и ** wildcard'ы.
 *
 * @module tools/fs/glob-search
 */

export const globSearchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'glob_search',
    description: 'Find files matching a glob pattern. Supports * and ** wildcards.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")' },
        path: { type: 'string', description: 'Search root directory (default: project root)' },
      },
      required: ['pattern'],
    },
  },
};

/** Конвертирует glob-паттерн в regex */
function globToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && i + 2 < pattern.length && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      re += '(.+/)?'; i += 3;
    } else if (c === '*' && i + 1 < pattern.length && pattern[i + 1] === '*') {
      re += '.*'; i += 2;
    } else if (c === '*') {
      re += '[^/]*'; i++;
    } else if (c === '?') {
      re += '[^/]'; i++;
    } else if (c === '.') {
      re += '\\.'; i++;
    } else if (/[+^${}()|[\]\\]/.test(c)) {
      re += '\\' + c; i++;
    } else {
      re += c; i++;
    }
  }
  return new RegExp(re + '$');
}

function walkGlob(
  dir: string,
  baseDir: string,
  regex: RegExp,
  results: string[],
  maxResults: number,
): void {
  if (results.length >= maxResults) return;

  const entries = readDirEntries(dir);

  for (const entry of entries) {
    if (results.length >= maxResults) break;
    const name = String(entry.name);
    if (IGNORE_DIRS.has(name) || name.startsWith('.')) continue;

    const fullPath = join(dir, name);
    const rel = normalizePath(fullPath.slice(baseDir.length + 1));

    if (entry.isDirectory()) {
      walkGlob(fullPath, baseDir, regex, results, maxResults);
    } else if (entry.isFile()) {
      if (regex.test(rel) || regex.test(name)) {
        results.push(rel);
      }
    }
  }
}

export function handleGlobSearch(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const pattern = String(args.pattern ?? '');
  const searchPath = String(args.path ?? '.');

  if (!pattern) return fsError('Pattern is required');

  const resolved = resolvePath(searchPath, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const regex = globToRegex(pattern);
  const results: string[] = [];
  const maxResults = 200;

  walkGlob(resolved.abs, resolved.abs, regex, results, maxResults);
  results.sort();

  if (results.length === 0) {
    return fsOk(`No files match pattern: ${pattern}`);
  }

  const truncated = results.length >= maxResults;
  const output = results.join('\n');
  const suffix = truncated ? `\n... (showing first ${maxResults} matches)` : '';

  return fsOk(`${results.length} match(es) for "${pattern}":\n${output}${suffix}`, truncated);
}

export const globSearchHandler: ToolHandler = {
  name: 'glob_search',
  definition: globSearchDefinition,
  async execute(args, ctx) {
    return handleGlobSearch(args, ctx.cwd);
  },
};
