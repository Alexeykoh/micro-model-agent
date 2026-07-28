import type { ToolDefinition } from './types'

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the internet for information. Returns relevant snippets and URLs.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (_ctx, args) => {
    const query = String(args.query)
    return { success: true, output: `[web_search would search for: ${query}]` }
  },
}
