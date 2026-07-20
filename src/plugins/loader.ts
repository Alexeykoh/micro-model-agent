import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentPlugin, PluginManifest } from './types.js';
import type { PluginManager } from './manager.js';
import { logInfo, logWarn, logError } from '../logger.js';

/**
 * Загрузчик плагинов.
 *
 * Discovery:
 * - ~/.mma/plugins/ — глобальные
 * - .mma/plugins/ — проектные
 *
 * Hot-reload: fs.watch на директорию плагина.
 *
 * @module plugins/loader
 */

/** Директории поиска плагинов */
const PLUGIN_DIRS = [
  join(process.env.HOME || process.env.USERPROFILE || '', '.mma', 'plugins'),
  '.mma/plugins',
];

/**
 * Сканирует директорию на наличие плагинов.
 * Плагин = директория с manifest.json.
 */
function scanPluginDir(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const plugins: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(dir, entry.name, 'manifest.json');
      if (existsSync(manifestPath)) {
        plugins.push(join(dir, entry.name));
      }
    }
  } catch { /* ignore */ }

  return plugins;
}

/**
 * Загружает манифест плагина.
 */
function loadManifest(pluginDir: string): PluginManifest | null {
  const manifestPath = join(pluginDir, 'manifest.json');
  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as PluginManifest;
    if (!manifest.name || !manifest.entry) {
      logWarn('PLUGIN', `Invalid manifest in ${pluginDir}: missing name or entry`);
      return null;
    }
    return manifest;
  } catch (e: any) {
    logError('PLUGIN', `Failed to load manifest ${manifestPath}: ${e.message}`);
    return null;
  }
}

/**
 * Загружает плагин из директории.
 *
 * Entry point может быть .ts (загружается через tsx) или .js/.mjs.
 */
async function loadPluginFromDir(pluginDir: string): Promise<AgentPlugin | null> {
  const manifest = loadManifest(pluginDir);
  if (!manifest) return null;

  const entryPath = join(pluginDir, manifest.entry);

  try {
    // Используем dynamic import для загрузки модуля
    const moduleUrl = pathToFileURL(entryPath).href;
    const mod = await import(moduleUrl);

    // Экспорт по умолчанию — фабрика плагина
    const createPlugin = mod.default || mod;
    const plugin: AgentPlugin = typeof createPlugin === 'function'
      ? createPlugin()
      : createPlugin;

    if (!plugin.name) {
      logWarn('PLUGIN', `Plugin from ${pluginDir} has no name`);
      return null;
    }

    return plugin;
  } catch (e: any) {
    logError('PLUGIN', `Failed to load plugin from ${pluginDir}: ${e.message}`);
    return null;
  }
}

/**
 * Загружает все плагины из директорий поиска.
 */
export async function loadAllPlugins(manager: PluginManager): Promise<void> {
  for (const dir of PLUGIN_DIRS) {
    const pluginDirs = scanPluginDir(dir);
    for (const pluginDir of pluginDirs) {
      const plugin = await loadPluginFromDir(pluginDir);
      if (plugin) {
        manager.register(plugin);
      }
    }
  }
}

/**
 * Включает hot-reload для плагина.
 *
 * При изменении entry point файла — деактивирует и перезагружает плагин.
 */
export function enableHotReload(
  pluginDir: string,
  manifest: PluginManifest,
  manager: PluginManager,
  reloadCallback?: (name: string) => void,
): () => void {
  const entryPath = join(pluginDir, manifest.entry);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const watcher = watch(entryPath, async (eventType) => {
      if (eventType !== 'change') return;

      // Debounce — ждём 500ms после последнего изменения
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        logInfo('PLUGIN', `hot-reload: ${manifest.name} changed, reloading...`);

        // Деактивируем старый
        await manager.deactivate(manifest.name);

        // Перезагружаем
        const plugin = await loadPluginFromDir(pluginDir);
        if (plugin) {
          manager.register(plugin);
          reloadCallback?.(manifest.name);
          logInfo('PLUGIN', `hot-reload: ${manifest.name} reloaded`);
        }
      }, 500);
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
    };
  } catch (e: any) {
    logWarn('PLUGIN', `hot-reload not available for ${pluginDir}: ${e.message}`);
    return () => {};
  }
}
