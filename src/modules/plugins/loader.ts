import { readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { PluginManager } from './manager'
import { t } from '../../i18n/index'
import type { AgentPlugin } from './types'

export class PluginLoader {
  loadFromDir(dirPath: string, pluginManager: PluginManager, logger?: { warn: (msg: string) => void }): void {
    if (!existsSync(dirPath)) return

    const entries = readdirSync(dirPath)
    for (const entry of entries) {
      const fullPath = join(dirPath, entry)
      if (!statSync(fullPath).isFile()) continue
      if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue

      try {
        const mod = require(fullPath) as { default?: AgentPlugin; plugin?: AgentPlugin }
        const plugin = mod.default || mod.plugin
        if (plugin && plugin.name) {
          pluginManager.register(plugin)
          logger?.warn(t('plugin.loaded', { name: plugin.name }))
        }
      } catch (e: any) {
        logger?.warn(t('plugin.skipped', { entry, message: e.message }))
      }
    }
  }
}
