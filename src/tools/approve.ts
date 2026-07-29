import * as readline from 'readline'
import type { ToolDefinition } from './types'

export const approveTool: ToolDefinition = {
  name: 'approve',
  description: 'Request user approval for an action. User must type "yes" or "y" to approve.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Description of the action requiring approval' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    const action = String(args.action || '')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise((resolve) => {
      rl.question(`Approve? ${action}\n(y/N): `, (answer: string) => {
        rl.close()
        const approved = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
        if (approved) {
          resolve({ success: true, output: 'Approved' })
        } else {
          resolve({ success: false, output: 'Rejected by user' })
        }
      })
    })
  },
}
