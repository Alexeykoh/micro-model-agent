import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import { resolvePath, IGNORE_DIRS, normalizePath, truncateOutput, readDirEntries } from './path-utils.js';
import { fsError, fsOk, MAX_OUTPUT_CHARS } from './types.js';

export const grepSearchDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grep_search',
    description: 'Search file contents by regex pattern. Returns matching lines with file:line.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern (e.g. "function", "\\.ts$", "import.*from"). Escape special chars: \\. \\( \\) \\[' },
        path: { type: 'string', description: 'Search root directory (default: project root)' },
        include: { type: 'string', description: 'File filter (e.g. "*.ts", "*.py")' },
        max_results: { type: 'number', description: 'Max results (default: 50)' },
      },
      required: ['pattern'],
    },
  },
};

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

function walkGrep(
  dir: string,
  baseDir: string,
  regex: RegExp,
  includePattern: RegExp | null,
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
    if (entry.isDirectory()) {
      walkGrep(fullPath, baseDir, regex, includePattern, results, maxResults);
    } else if (entry.isFile()) {
      if (includePattern && !includePattern.test(name)) continue;
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const rel = normalizePath(fullPath.slice(baseDir.length + 1));
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          if (regex.test(lines[i])) {
            results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      } catch {
        // skip binary/unreadable files
      }
    }
  }
}

export function handleGrepSearch(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const pattern = String(args.pattern ?? '');
  const searchPath = String(args.path ?? '.');
  const include = args.include ? String(args.include) : null;
  const maxResults = Math.min(200, Math.max(1, Number(args.max_results ?? 50)));

  if (!pattern) return fsError('Pattern is required');

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch (e: any) {
    return fsError(`Invalid regex: ${e.message}`);
  }

  const resolved = resolvePath(searchPath, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const includeRegex = include ? globToRegex(include) : null;
  const results: string[] = [];

  walkGrep(resolved.abs, resolved.abs, regex, includeRegex, results, maxResults);

  if (results.length === 0) {
    return fsOk(`No matches for pattern: ${pattern}`);
  }

  const truncated = results.length >= maxResults;
  const { text, truncated: truncatedOutput } = truncateOutput(results.join('\n'), MAX_OUTPUT_CHARS);

  return fsOk(`${results.length} match(es) for "${pattern}":\n${text}`, truncated || truncatedOutput);
}
