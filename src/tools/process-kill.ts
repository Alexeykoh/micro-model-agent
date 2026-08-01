import type { ToolDefinition } from './types'
import { processRegistry } from '../modules/processes'
import { t } from '../i18n/index'

export const processKillTool: ToolDefinition = {
  name: 'process_kill',
  description: 'Stop a background process started via bash (dev server, watcher). Kills the whole process tree (children included). Use the id returned by bash or process_list.',
  tags: ['shell'],
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Process id from bash output or process_list' },
    },
    required: ['id'],
  },
  handler: async (ctx, args) => {
    const id = String(args.id)
    const entry = processRegistry.get(id)
    if (!entry) {
      return { success: false, output: t('proc.not_found', { id }) }
    }
    const killed = processRegistry.kill(id)
    if (!killed) {
      return { success: false, output: t('proc.kill_failed', { id }) }
    }
    return {
      success: true,
      output: t('proc.killed', { id, pid: entry.pid }),
    }
  },
}
