import { writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolDefinition } from '../registry.js';
import { resolvePath, normalizePath } from './path-utils.js';
import { fsError, fsOk } from './types.js';

export const writeFileDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a file. Creates parent directories automatically. Atomic write (crash-safe).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to project root)' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
};

export function handleWriteFile(
  args: Record<string, unknown>,
  cwd: string,
): ReturnType<typeof fsOk> {
  const path = String(args.path ?? '');
  const content = args.content;

  if (typeof content !== 'string') {
    return fsError('Content must be a string');
  }

  const resolved = resolvePath(path, cwd);
  if (!resolved.ok) return fsError(resolved.error);

  const dir = dirname(resolved.abs);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    return fsError(`Cannot create directory: ${e.message}`);
  }

  const tmpPath = resolved.abs + '.mma.tmp';
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    if (existsSync(resolved.abs)) {
      unlinkSync(resolved.abs);
    }
    renameSync(tmpPath, resolved.abs);
  } catch (e: any) {
    // Cleanup tmp file on failure
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    return fsError(`Write failed: ${e.message}`);
  }

  const lines = content.split('\n').length;
  return fsOk(`Written ${content.length} bytes (${lines} lines) to ${normalizePath(path)}`);
}
