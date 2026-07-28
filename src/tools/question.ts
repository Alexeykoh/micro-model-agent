import type { ToolDefinition } from './types'

export const questionTool: ToolDefinition = {
  name: 'question',
  description: 'Ask the user a question when clarification is needed. Optionally provide choices.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Question to ask' },
      options: { type: 'array', items: { type: 'string' }, description: 'Available choices' },
    },
    required: ['question'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Question asked: ${args.question}]` }
  },
}
