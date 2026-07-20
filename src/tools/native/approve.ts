import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';

/**
 * Нативный инструмент approve — запрос подтверждения у пользователя.
 * Приостанавливает ReAct-цикл до получения ответа.
 *
 * @module tools/native/approve
 */

export const approveDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'approve',
    description: 'Request user approval for an action. Pauses the agent loop until approved.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action to approve' },
      },
      required: ['action'],
    },
  },
};

export const approveHandler: ToolHandler = {
  name: 'approve',
  definition: approveDefinition,
  async execute(args, ctx) {
    const action = String(args.action || args.text || '');

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('approve', action);
    }

    return {
      stdout: `Approval requested: ${action}`,
      stderr: '',
      exitCode: 0,
      truncated: false,
      questionPending: true,
      breakLoop: true,
    };
  },
};
