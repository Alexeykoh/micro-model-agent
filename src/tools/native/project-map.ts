import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { getOrBuildProjectMap } from '../../indexer/cache.js';

/**
 * Инструмент project_map — получение информации о структуре проекта.
 *
 * Позволяет агенту запросить:
 * - Полную карту проекта (список файлов с экспортом)
 * - Поиск файлов по паттерну
 * - Информацию о конкретном файле
 *
 * @module tools/native/project-map
 */

export const projectMapDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'project_map',
    description: 'Get project structure information. Use this FIRST before reading any files to understand what exists in the project.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'find', 'info'],
          description: 'list = show all files, find = search by pattern, info = show details of specific file',
        },
        pattern: {
          type: 'string',
          description: 'For "find" action: glob pattern to match files (e.g. "*.tsx", "src/**/*.ts")',
        },
        path: {
          type: 'string',
          description: 'For "info" action: path to specific file',
        },
      },
      required: ['action'],
    },
  },
};

export const projectMapHandler: ToolHandler = {
  name: 'project_map',
  definition: projectMapDefinition,
  async execute(args, ctx) {
    const action = String(args.action || 'list');
    const pattern = String(args.pattern || '');
    const filePath = String(args.path || '');

    try {
      const { map, formatted } = getOrBuildProjectMap(process.cwd());

      switch (action) {
        case 'list': {
          if (map.files.length === 0) {
            return {
              stdout: 'Project is empty or not indexed. No source files found.',
              stderr: '',
              exitCode: 0,
              truncated: false,
            };
          }
          return {
            stdout: formatted,
            stderr: '',
            exitCode: 0,
            truncated: false,
          };
        }

        case 'find': {
          if (!pattern) {
            return {
              stdout: 'Error: pattern is required for "find" action. Example: "*.tsx" or "src/**/*.ts"',
              stderr: '',
              exitCode: 1,
              truncated: false,
            };
          }

          // Simple glob matching — *.tsx matches any .tsx file, **/*.tsx matches nested
          const hasSlash = pattern.includes('/');
          let regexStr: string;
          if (hasSlash) {
            // Pattern has directory separator — match exactly
            regexStr = '^' +
              pattern
                .replace(/\*\*/g, '{{GLOBSTAR}}')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '[^/]')
                .replace(/\./g, '\\.')
                .replace(/\{\{GLOBSTAR\}\}/g, '.*')
              + '$';
          } else {
            // No directory separator — match filename only (any depth)
            regexStr = '(^|/)' +
              pattern
                .replace(/\*\*/g, '{{GLOBSTAR}}')
                .replace(/\*/g, '[^/]*')
                .replace(/\?/g, '[^/]')
                .replace(/\./g, '\\.')
                .replace(/\{\{GLOBSTAR\}\}/g, '.*')
              + '$';
          }
          const regex = new RegExp(regexStr);

          const matches = map.files.filter(f => regex.test(f.path));

          if (matches.length === 0) {
            return {
              stdout: `No files match pattern: ${pattern}`,
              stderr: '',
              exitCode: 0,
              truncated: false,
            };
          }

          const output = matches.map(f => {
            const expStr = f.exports.length > 0 ? ` (exports: ${f.exports.join(', ')})` : '';
            return `${f.path}${expStr}`;
          }).join('\n');

          return {
            stdout: `Found ${matches.length} file(s):\n${output}`,
            stderr: '',
            exitCode: 0,
            truncated: false,
          };
        }

        case 'info': {
          if (!filePath) {
            return {
              stdout: 'Error: path is required for "info" action. Example: "src/App.tsx"',
              stderr: '',
              exitCode: 1,
              truncated: false,
            };
          }

          // Normalize path
          const normalizedPath = filePath.replace(/\\/g, '/');
          const file = map.files.find(f => f.path === normalizedPath);

          if (!file) {
            // Try partial match
            const partialMatch = map.files.find(f => f.path.endsWith(normalizedPath) || f.path.includes(normalizedPath));
            if (partialMatch) {
              return {
                stdout: `File not found at exact path: ${filePath}\nDid you mean: ${partialMatch.path}?\n\nPath: ${partialMatch.path}\nLines: ${partialMatch.lines}\nExports: ${partialMatch.exports.length > 0 ? partialMatch.exports.join(', ') : 'none'}`,
                stderr: '',
                exitCode: 0,
                truncated: false,
              };
            }
            return {
              stdout: `File not found: ${filePath}\n\nAvailable files:\n${map.files.slice(0, 20).map(f => `  ${f.path}`).join('\n')}${map.files.length > 20 ? `\n  ... and ${map.files.length - 20} more` : ''}`,
              stderr: '',
              exitCode: 0,
              truncated: false,
            };
          }

          return {
            stdout: `Path: ${file.path}\nLines: ${file.lines}\nExports: ${file.exports.length > 0 ? file.exports.join(', ') : 'none'}`,
            stderr: '',
            exitCode: 0,
            truncated: false,
          };
        }

        default:
          return {
            stdout: `Unknown action: ${action}. Use "list", "find", or "info".`,
            stderr: '',
            exitCode: 1,
            truncated: false,
          };
      }
    } catch (e: any) {
      return {
        stdout: `Error accessing project map: ${e.message}`,
        stderr: '',
        exitCode: 1,
        truncated: false,
      };
    }
  },
};
