import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { addTodo, doneTodo, removeTodo, listTodos } from '../todo.js';

/**
 * Нативный инструмент todo — управление списком задач.
 *
 * @module tools/native/todo
 */

export const todoDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'todo',
    description: 'Manage a todo list. Actions: add, done, remove, list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'add, done, remove, list' },
        text: { type: 'string', description: 'Todo text (for add/done/remove)' },
      },
      required: ['action'],
    },
  },
};

export const todoHandler: ToolHandler = {
  name: 'todo',
  definition: todoDefinition,
  async execute(args, ctx) {
    const action = String(args.action || 'list');
    const text = String(args.text || '');

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('todo', action);
    }

    let output = '';
    let exitCode = 0;

    switch (action) {
      case 'add': output = addTodo(text); break;
      case 'done': output = doneTodo(text); break;
      case 'remove': case 'rm': output = removeTodo(text); break;
      case 'list': case 'ls': output = listTodos(); break;
      default: output = 'Unknown todo action. Use: add, done, remove, list'; exitCode = 1;
    }

    if (!ctx.quiet && exitCode === 0 && output) {
      ctx.renderer?.writeLine(output);
    }

    return { stdout: output, stderr: '', exitCode, truncated: false };
  },
};
