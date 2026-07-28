import type { ToolDefinition } from './types'

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL and convert its content to markdown. Use for reading documentation, APIs, web pages.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  handler: async (_ctx, args) => {
    const url = String(args.url)
    try {
      const response = await fetch(url)
      if (!response.ok) {
        return { success: false, output: `HTTP ${response.status}: ${response.statusText}` }
      }
      const text = await response.text()
      return { success: true, output: text.slice(0, 50_000) }
    } catch (e: any) {
      return { success: false, output: `Fetch failed: ${e.message}` }
    }
  },
}
