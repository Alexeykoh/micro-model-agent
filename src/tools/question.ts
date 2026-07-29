import * as readline from 'readline'
import type { ToolDefinition } from './types'

export const questionTool: ToolDefinition = {
  name: 'question',
  description: 'Ask the user a question and get their response.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Question to ask the user' },
    },
    required: ['question'],
  },
  handler: async (_ctx, args) => {
    const question = String(args.question || '')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
      rl.question(`${question} `, (answer: string) => {
        rl.close()
        resolve({ success: true, output: answer.trim() })
      })
    })
  },
}
