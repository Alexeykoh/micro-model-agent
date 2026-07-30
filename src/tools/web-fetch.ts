import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

const MAX_CHARS = 15000

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a URL and convert its content to markdown. Use for reading documentation, APIs, web pages.',
  tags: ['research'],
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
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        return { success: false, output: t('error.http', { status: response.status, statusText: response.statusText }) }
      }
      const contentType = response.headers.get('content-type') || ''
      const text = await response.text()
      const cleaned = contentType.includes('html') ? stripHtml(text) : text
      if (cleaned.length > MAX_CHARS) {
        return { success: true, output: cleaned.slice(0, MAX_CHARS) + t('file.truncated') }
      }
      return { success: true, output: cleaned || t('file.empty_page') }
    } catch (e: any) {
      return { success: false, output: t('error.fetch_failed', { message: e.message }) }
    }
  },
}
