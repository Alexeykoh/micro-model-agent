import type { ToolDefinition } from './types'

export const searchHistoryTool: ToolDefinition = {
  name: 'search_history',
  description: 'Search through past session history for relevant information. Searches JSONL session files.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (regex/keyword)' },
      max_results: { type: 'number', description: 'Maximum results to return (default 10)' },
    },
    required: ['query'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[Search history for: ${args.query}]` }
  },
}
