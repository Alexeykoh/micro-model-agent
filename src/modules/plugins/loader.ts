import { readdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { PluginManager } from './manager'
import { t } from '../../i18n/index'
import type { AgentPlugin } from './types'

/**
 * Entry file candidates for folder plugins. Looked up in order:
 * `plugin.ts` > `plugin.js` > `index.ts` > `index.js`.
 */
const FOLDER_ENTRY_NAMES = ['plugin.ts', 'plugin.js', 'index.ts', 'index.js']

export class PluginLoader {
  loadFromDir(dirPath: string, pluginManager: PluginManager, logger?: { warn: (msg: string) => void }): void {
    if (!existsSync(dirPath)) return

    const entries = readdirSync(dirPath).sort()
    for (const entry of entries) {
      const fullPath = join(dirPath, entry)
      const stat = statSync(fullPath)

      if (stat.isFile()) {
        if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue
        this.tryLoad(fullPath, entry, pluginManager, logger)
      } else if (stat.isDirectory()) {
        const entryFile = this.findEntryFile(fullPath)
        if (entryFile) {
          this.tryLoad(entryFile, `${entry}/${basename(entryFile)}`, pluginManager, logger)
        }
      }
    }
  }

  private findEntryFile(dir: string): string | null {
    for (const name of FOLDER_ENTRY_NAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private tryLoad(fullPath: string, label: string, pluginManager: PluginManager, logger?: { warn: (msg: string) => void }): void {
    try {
      const mod = require(fullPath) as { default?: AgentPlugin; plugin?: AgentPlugin }
      const plugin = mod.default || mod.plugin
      if (plugin && plugin.name) {
        pluginManager.register(plugin)
        logger?.warn(t('plugin.loaded', { name: plugin.name }))
      }
    } catch (e: any) {
      logger?.warn(t('plugin.skipped', { entry: label, message: e.message }))
    }
  }
}
