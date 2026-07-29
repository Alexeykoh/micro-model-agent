import { t } from '../i18n/index'
import type { ToolDefinition } from './types'

export const todoTool: ToolDefinition = {
  name: 'todo',
  description: 'Manage sub-tasks. Add items to a todo list, mark them done, or list current items.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'done', 'list'] },
      items: { type: 'array', items: { type: 'string' } },
    },
    required: ['action'],
  },
  handler: async (_ctx, args) => {
    const action = String(args.action || '')
    const items = Array.isArray(args.items) ? args.items : []
    if (action === 'add' && items.length > 0) {
      return { success: true, output: t('todo.added', { count: items.length, items: items.join(', ') }) }
    }
    if (action === 'done') {
      return { success: true, output: t('todo.marked_done', { count: items.length }) }
    }
    if (action === 'list') {
      return { success: true, output: t('todo.no_active') }
    }
    return { success: false, output: t('todo.unknown_action', { action }) }
  },
}
