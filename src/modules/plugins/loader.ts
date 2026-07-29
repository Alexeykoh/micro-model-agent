import { readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { PluginManager } from './manager'
import type { AgentPlugin } from './types'

export class PluginLoader {
  loadFromDir(dirPath: string, pluginManager: PluginManager): void {
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
        }
      } catch { /* skip invalid plugins */ }
    }
  }
}
