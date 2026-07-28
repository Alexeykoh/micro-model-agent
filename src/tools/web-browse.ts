import type { ToolDefinition } from './types'

export const webBrowseTool: ToolDefinition = {
  name: 'web_browse',
  description: 'Headless browser for complex web interactions: navigation, clicking, form filling, screenshots. Requires playwright.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: navigate, click, screenshot, extract' },
      url: { type: 'string', description: 'URL to navigate to' },
      selector: { type: 'string', description: 'CSS selector for click/extract' },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    return { success: true, output: `[web_browse action=${args.action} url=${args.url}]` }
  },
}
