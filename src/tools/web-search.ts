import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information. Returns search results with titles and snippets.',
  tags: ['research'],
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      numResults: { type: 'number', description: 'Number of results (default 5)' },
    },
    required: ['query'],
  },
  handler: async (_ctx, args) => {
    const query = String(args.query || '')
    const numResults = Number(args.numResults) || 5
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
      const html = await response.text()
      const results: string[] = []
      const snippetRegex = /<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
      let match
      let count = 0
      while ((match = snippetRegex.exec(html)) !== null && count < numResults) {
        const title = match[1].replace(/<[^>]+>/g, '').trim()
        const snippet = match[2].replace(/<[^>]+>/g, '').trim()
        results.push(`${title}: ${snippet}`)
        count++
      }
      if (results.length === 0) {
        return { success: true, output: t('tool.no_results', { query }) }
      }
      return { success: true, output: t('tool.search_results', { query, results: results.join('\n') }) }
    } catch (err: any) {
      return { success: false, output: t('error.search_failed', { message: err.message }) }
    }
  },
}
