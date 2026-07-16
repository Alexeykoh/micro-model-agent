import type { ChatMessage } from '../llm/provider.js';
import { executeBash, BashResult } from './bash.js';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolResult = BashResult;

export class ToolRegistry {
  async execute(toolCall: ToolCall): Promise<ToolResult> {
    if (toolCall.name === 'bash') {
      const cmd = String(toolCall.arguments.cmd ?? '');
      const timeout = Number(toolCall.arguments.timeout ?? 120);
      return executeBash(cmd, timeout);
    }
    return { stdout: '', stderr: `Unknown tool: ${toolCall.name}`, exitCode: 1, truncated: false };
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: `Execute a shell command in the project directory (PowerShell on Windows).
Examples:
  dir                 → list files
  Get-Content file.ts → read file
  npm test            → run tests
  git diff            → show changes`,
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string', description: 'The command to execute (PowerShell on Windows)' },
              timeout: { type: 'number', description: 'Seconds before timeout (default 120, max 600)' },
            },
            required: ['cmd'],
          },
        },
      },
    ];
  }

  isToolCall(message: ChatMessage): boolean {
    return message.role === 'assistant' && message.content === '';
  }
}
