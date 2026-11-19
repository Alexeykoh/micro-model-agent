// Перезагрузка каталогов плагинов. Вынесена из `manager.ts`: функции не трогают
// внутреннее состояние реестра, а только гоняют `PluginLoader` и `unloadByDir`.
import type { PluginManager } from "./manager";
import { PluginLoader, invalidateModuleCache } from "./loader";
import type { PluginDirs, ReloadReport } from "./manager-types";

/**
 * Перезагрузить оба каталога: выгрузить внешние плагины (с `onUnload`), сбросить
 * кэш модулей, прочитать заново.
 *
 * Живёт здесь, а не в отдельном сервисе, потому что каталоги известны только
 * bootstrap'у, а перезагружать должны все три поверхности (CLI, REPL, веб) —
 * иначе каждая завела бы свою копию этого кода.
 */
export function reloadPluginDirs(
  pluginManager: PluginManager,
  dirs: PluginDirs,
  options?: { mmaVersion?: string },
  logger?: { warn: (msg: string) => void },
): ReloadReport {
  const loader = new PluginLoader();
  const loaded = (dir: string, source: "global" | "project") =>
    loader.reloadFromDir(dir, pluginManager, logger, { source, mmaVersion: options?.mmaVersion });
  const global = loaded(dirs.globalPluginsDir, "global");
  const project = loaded(dirs.projectPluginsDir, "project");
  return {
    unloaded: global.unloaded + project.unloaded,
    loaded: global.loaded + project.loaded,
    failed: global.failed + project.failed,
    staleTs: global.staleTs + project.staleTs,
  };
}

/**
 * Выгрузить внешние плагины и сбросить кэш модулей **без** чтения заново.
 *
 * Нужно перед полной пересборкой bootstrap (`/reload` в REPL): bootstrap создаёт
 * новый `PluginManager`, и старые плагины без `onUnload` тихо пережили бы
 * пересборку вместе со своими серверами. Заодно сбрасываем кэш — иначе новый
 * bootstrap получил бы прежние версии файлов из `require`.
 */
export function unloadPluginsForReboot(
  pluginManager: PluginManager,
  dirs: PluginDirs,
  logger?: { warn: (msg: string) => void },
): string[] {
  const loader = new PluginLoader();
  const unloaded: string[] = [];
  for (const dir of [dirs.globalPluginsDir, dirs.projectPluginsDir]) {
    for (const { path } of loader.entryFiles(dir, logger)) invalidateModuleCache(path, logger);
    unloaded.push(...pluginManager.unloadByDir(dir));
  }
  pluginManager.clearFailures();
  return unloaded;
}
