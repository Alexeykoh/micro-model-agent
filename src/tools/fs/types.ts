import type { ToolResult } from '../registry.js';

export type FsToolResult = ToolResult;

export function fsError(message: string): FsToolResult {
  return { stdout: '', stderr: message, exitCode: 1, truncated: false };
}

export function fsOk(stdout: string, truncated = false): FsToolResult {
  return { stdout, stderr: '', exitCode: 0, truncated };
}

export const MAX_OUTPUT_CHARS = 16000;
export const MAX_LINE_COUNT = 500;
