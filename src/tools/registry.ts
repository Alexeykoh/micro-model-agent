import type { ChatMessage } from '../llm/provider.js';
import { readFileDefinition } from './fs/read-file.js';
import { writeFileDefinition } from './fs/write-file.js';
import { editFileDefinition } from './fs/edit-file.js';
import { listDirDefinition } from './fs/list-dir.js';
import { scaffoldDefinition } from './native/scaffold.js';
import { projectMapDefinition } from './native/project-map.js';
import { createDirDefinition } from './fs/create-dir.js';
import { deleteFileDefinition } from './fs/delete-file.js';
import { copyFileDefinition } from './fs/copy-file.js';
import { moveFileDefinition } from './fs/move-file.js';
import { fileInfoDefinition } from './fs/file-info.js';
import { globSearchDefinition } from './fs/glob-search.js';
import { grepSearchDefinition } from './fs/grep-search.js';
import { treeDefinition } from './fs/tree.js';
import { bashDefinition } from './bash.js';
import { webSearchDefinition } from './web-search.js';
import { webFetchDefinition } from './web-fetch.js';
import type { BashResult } from './bash.js';

/**
 * Реестр всех инструментов агента.
 *
 * Хранит определения инструментов для LLM и валидирует имена.
 * Исполнение вынесено в ToolExecutor (src/agent/tool-executor.ts).
 *
 * @module tools/registry
 */

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

/** Все определения инструментов (для system prompt) */
const ALL_DEFINITIONS: ToolDefinition[] = [
  // Native
  {
    type: 'function',
    function: {
      name: 'subagent',
      description: 'Delegate a task to an isolated agent in a fresh context. Use for EACH file when creating 3+ new files. Arguments: task (required, what to do), existingFiles (optional, comma-separated files for context).',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What the subagent should create/fix/check' },
          existingFiles: { type: 'string', description: 'Comma-separated files the subagent can read for context (optional)' },
        },
        required: ['task'],
      },
    },
  },
  // Bash
  bashDefinition,
  // Scaffold
  scaffoldDefinition,
  // Project Map
  projectMapDefinition,
  // FS
  readFileDefinition,
  writeFileDefinition,
  editFileDefinition,
  listDirDefinition,
  createDirDefinition,
  deleteFileDefinition,
  copyFileDefinition,
  moveFileDefinition,
  fileInfoDefinition,
  globSearchDefinition,
  grepSearchDefinition,
  treeDefinition,
  // Web
  webSearchDefinition,
  webFetchDefinition,
];

const VALID_TOOL_NAMES = new Set(ALL_DEFINITIONS.map(d => d.function.name));

/**
 * Реестр инструментов — хранит определения и валидирует имена.
 * Исполнение — через ToolExecutor.
 */
export class ToolRegistry {
  /** Возвращает определения всех доступных инструментов для system prompt */
  getDefinitions(): ToolDefinition[] {
    return ALL_DEFINITIONS;
  }

  isToolCall(message: ChatMessage): boolean {
    return message.role === 'assistant' && message.content === '';
  }

  isValidTool(name: string): boolean {
    return VALID_TOOL_NAMES.has(name);
  }
}
