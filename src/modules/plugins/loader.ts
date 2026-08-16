import { readdirSync, existsSync, statSync } from 'fs'
import { join, basename } from 'path'
import { PluginManager } from './manager'
import { t } from '../../i18n/index'
import { semverGt } from '../updater/checker'
import type { AgentPlugin } from './types'

/**
 * Entry file candidates for folder plugins. Looked up in order:
 * `plugin.ts` > `plugin.js` > `index.ts` > `index.js`.
 */
const FOLDER_ENTRY_NAMES = ['plugin.ts', 'plugin.js', 'index.ts', 'index.js']

export interface LoadFromDirOptions {
  source?: 'global' | 'project'
  /** Current MMA version (semver). When set, plugins declaring a higher `minMmaVersion` are skipped. */
  mmaVersion?: string
}

export class PluginLoader {
  loadFromDir(
    dirPath: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
    options?: LoadFromDirOptions,
  ): void {
    if (!existsSync(dirPath)) return

    const entries = readdirSync(dirPath).sort()
    for (const entry of entries) {
      const fullPath = join(dirPath, entry)
      const stat = statSync(fullPath)

      if (stat.isFile()) {
        if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue
        this.tryLoad(fullPath, entry, pluginManager, logger, options)
      } else if (stat.isDirectory()) {
        const entryFile = this.findEntryFile(fullPath)
        if (entryFile) {
          this.tryLoad(entryFile, `${entry}/${basename(entryFile)}`, pluginManager, logger, options)
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

  private tryLoad(
    fullPath: string,
    label: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
    options?: LoadFromDirOptions,
  ): void {
    try {
      const mod = require(fullPath) as { default?: AgentPlugin; plugin?: AgentPlugin }
      const plugin = mod.default || mod.plugin
      if (plugin && plugin.name) {
        if (
          plugin.minMmaVersion &&
          options?.mmaVersion &&
          semverGt(plugin.minMmaVersion, options.mmaVersion)
        ) {
          logger?.warn(
            t('plugin.incompatible', {
              name: plugin.name,
              min: plugin.minMmaVersion,
              current: options.mmaVersion,
            }),
          )
          return
        }
        const result = pluginManager.register(plugin, options?.source)
        if (result.status === 'registered') {
          logger?.warn(t('plugin.loaded', { name: plugin.name }))
        } else if (result.status === 'skipped_older') {
          logger?.warn(
            t('plugin.dedup_older', {
              name: plugin.name,
              version: plugin.version || '0.0.0',
            }),
          )
        }
      }
    } catch (e: any) {
      logger?.warn(t('plugin.skipped', { entry: label, message: e.message }))
    }
  }
}
