import * as fs from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ToolDefinition } from './types'

export const searchHistoryTool: ToolDefinition = {
  name: 'search_history',
  description: 'Search through session history for past interactions.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'number', description: 'Maximum results (default 5)' },
    },
    required: ['query'],
  },
  handler: async (_ctx, args) => {
    const query = String(args.query || '').toLowerCase()
    const maxResults = Number(args.maxResults) || 5
    const historyDir = join(homedir(), '.mma', 'history')
    try {
      const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl')).sort().reverse().slice(0, 10)
      const results: string[] = []
      for (const file of files) {
        const content = fs.readFileSync(join(historyDir, file), 'utf-8')
        for (const line of content.split('\n').filter(Boolean)) {
          if (line.toLowerCase().includes(query)) {
            try {
              const entry = JSON.parse(line)
              results.push(`[${file}] ${JSON.stringify(entry).slice(0, 200)}`)
            } catch { /* skip */ }
          }
          if (results.length >= maxResults) break
        }
        if (results.length >= maxResults) break
      }
      if (results.length === 0) {
        return { success: true, output: `No history entries matching "${query}"` }
      }
      return { success: true, output: `History results for "${query}":\n${results.join('\n')}` }
    } catch {
      return { success: true, output: `No history directory found at ${historyDir}` }
    }
  },
}
