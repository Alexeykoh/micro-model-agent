import type { ChatMessage } from '../llm/provider.js';
import { executeBash, type BashResult } from './bash.js';
import { readFileDefinition, handleReadFile } from './fs/read-file.js';
import { writeFileDefinition, handleWriteFile } from './fs/write-file.js';
import { editFileDefinition, handleEditFile } from './fs/edit-file.js';
import { listDirDefinition, handleListDir } from './fs/list-dir.js';
import { createDirDefinition, handleCreateDir } from './fs/create-dir.js';
import { deleteFileDefinition, handleDeleteFile } from './fs/delete-file.js';
import { copyFileDefinition, handleCopyFile } from './fs/copy-file.js';
import { moveFileDefinition, handleMoveFile } from './fs/move-file.js';
import { fileInfoDefinition, handleFileInfo } from './fs/file-info.js';
import { globSearchDefinition, handleGlobSearch } from './fs/glob-search.js';
import { grepSearchDefinition, handleGrepSearch } from './fs/grep-search.js';
import { treeDefinition, handleTree } from './fs/tree.js';

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

type ToolHandler = (args: Record<string, unknown>, cwd: string) => ToolResult;

const FS_HANDLERS = new Map<string, { def: ToolDefinition; handler: ToolHandler }>([
  ['read_file',    { def: readFileDefinition,    handler: handleReadFile }],
  ['write_file',   { def: writeFileDefinition,   handler: handleWriteFile }],
  ['edit_file',    { def: editFileDefinition,    handler: handleEditFile }],
  ['list_dir',     { def: listDirDefinition,     handler: handleListDir }],
  ['create_dir',   { def: createDirDefinition,   handler: handleCreateDir }],
  ['delete_file',  { def: deleteFileDefinition,  handler: handleDeleteFile }],
  ['copy_file',    { def: copyFileDefinition,    handler: handleCopyFile }],
  ['move_file',    { def: moveFileDefinition,    handler: handleMoveFile }],
  ['file_info',    { def: fileInfoDefinition,    handler: handleFileInfo }],
  ['glob_search',  { def: globSearchDefinition,  handler: handleGlobSearch }],
  ['grep_search',  { def: grepSearchDefinition,  handler: handleGrepSearch }],
  ['tree',         { def: treeDefinition,         handler: handleTree }],
]);

const VALID_TOOL_NAMES = new Set(['bash', ...FS_HANDLERS.keys()]);

export class ToolRegistry {
  constructor(private cwd: string = process.cwd()) {}

  async execute(toolCall: ToolCall): Promise<ToolResult> {
    const fsEntry = FS_HANDLERS.get(toolCall.name);
    if (fsEntry) {
      try {
        return fsEntry.handler(toolCall.arguments, this.cwd);
      } catch (e: any) {
        return { stdout: '', stderr: `Tool error: ${e.message}`, exitCode: 1, truncated: false };
      }
    }

    if (toolCall.name === 'bash') {
      const cmd = String(toolCall.arguments.cmd ?? '');
      const timeout = Number(toolCall.arguments.timeout ?? 120);
      return executeBash(cmd, timeout);
    }

    return { stdout: '', stderr: `Unknown tool: ${toolCall.name}`, exitCode: 1, truncated: false };
  }

  getDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'bash',
          description: `Execute a shell command. Use for non-file operations (npm, git, etc).`,
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string', description: 'The command to execute' },
              timeout: { type: 'number', description: 'Seconds before timeout (default 120, max 600)' },
            },
            required: ['cmd'],
          },
        },
      },
    ];

    for (const entry of FS_HANDLERS.values()) {
      defs.push(entry.def);
    }

    return defs;
  }

  isToolCall(message: ChatMessage): boolean {
    return message.role === 'assistant' && message.content === '';
  }

  isValidTool(name: string): boolean {
    return VALID_TOOL_NAMES.has(name);
  }
}
