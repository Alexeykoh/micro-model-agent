import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';

/**
 * Нативный инструмент question — запрос вопроса пользователю.
 * Приостанавливает ReAct-цикл до получения ответа.
 *
 * @module tools/native/question
 */

export const questionDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'question',
    description: 'Ask the user a question. Pauses the agent loop until answered.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to ask' },
        choices: { type: 'array', items: { type: 'string' }, description: 'Optional choice options' },
      },
      required: ['question'],
    },
  },
};

export const questionHandler: ToolHandler = {
  name: 'question',
  definition: questionDefinition,
  async execute(args, ctx) {
    const question = String(args.question || args.text || '');
    const choicesArr = Array.isArray(args.choices) ? args.choices : [];

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('question', question);
    }

    return {
      stdout: `Question asked: ${question}`,
      stderr: '',
      exitCode: 0,
      truncated: false,
      questionPending: true,
      breakLoop: true,
    };
  },
};
