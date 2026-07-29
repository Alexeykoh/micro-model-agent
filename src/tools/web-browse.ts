import type { ToolDefinition } from './types'

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: 'Fetch and read a web page. Returns the page content as plain text.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
  handler: async (_ctx, args) => {
    const url = String(args.url || '')
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      const text = await response.text()
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const maxLen = 8000
      const content = stripped.length > maxLen ? stripped.slice(0, maxLen) + '\n... (truncated)' : stripped
      return { success: true, output: content || '(empty page)' }
    } catch (err: any) {
      return { success: false, output: `Failed to fetch ${url}: ${err.message}` }
    }
  },
}
