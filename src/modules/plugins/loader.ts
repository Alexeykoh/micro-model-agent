// Загрузчик плагинов из каталогов: файлы и папки, гейт по minMmaVersion.
import { readdirSync, existsSync, statSync, type Stats } from "fs";
import { join, basename } from "path";
import type { PluginManager, ReloadReport } from "./manager";
import { t } from "../../i18n/index";
import { semverGt } from "../updater/checker";
import type { AgentPlugin } from "./types";

/**
 * Кандидаты точки входа для плагинов-папок. Порядок:
 * `plugin.ts` > `plugin.js` > `index.ts` > `index.js`.
 */
const FOLDER_ENTRY_NAMES = ["plugin.ts", "plugin.js", "index.ts", "index.js"];

/**
 * Сбросить кэш модуля, чтобы `require` прочитал файл заново.
 *
 * Проверено экспериментально: под Bun работает и для `.ts`, и для `.js`; под
 * Node — для `.js`, но `.ts` остаётся старым (Node кэширует transpile отдельно,
 * `delete require.cache` его не трогает). Отсюда `isStaleAfterInvalidate`.
 */
export function invalidateModuleCache(
  fullPath: string,
  logger?: { warn: (msg: string) => void },
): void {
  try {
    delete require.cache[require.resolve(fullPath)];
  } catch (e) {
    // Не в кэше (первая загрузка) или resolve не удался — не страшно.
    logger?.warn(`Plugin cache not invalidated for "${fullPath}": ${String(e)}`);
  }
}

/** Под Node `.ts` перечитывается только рестартом процесса. */
export function isStaleAfterInvalidate(fullPath: string): boolean {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return !isBun && fullPath.endsWith(".ts");
}

/** Опции загрузки из каталога: источник и текущая версия MMA для гейта. */
export interface LoadFromDirOptions {
  source?: "global" | "project";
  /** Текущая версия MMA (semver). Плагины с более высоким `minMmaVersion` пропускаются. */
  mmaVersion?: string;
}

/**
 * Итог сканирования каталога. Раньше `loadFromDir` возвращал `void`, из-за чего
 * нельзя было отличить «каталога нет» от «загрузилось ноль» — это понадобилось
 * для диффа при reload.
 */
export interface LoadReport {
  /** Зарегистрировано (включая замену более старой версии). */
  loaded: number;
  /** Пропущено: гейт версии, дедуп, невалидные метаданные. */
  skipped: number;
  /** Упало на импорте — записи попадают в `PluginManager.getFailures()`. */
  failed: number;
}

/** Грузит плагины из каталога и регистрирует в менеджере (битые — скип с варном). */
export class PluginLoader {
  /**
   * Сканирует каталог и возвращает точки входа: `[{path, label}]`
   * (файлы `.ts/.js` и папки с entry-файлом). Нет каталога — пусто.
   */
  entryFiles(
    dirPath: string,
    logger?: { warn: (msg: string) => void },
  ): Array<{ path: string; label: string }> {
    const found: Array<{ path: string; label: string }> = [];
    if (!existsSync(dirPath)) return found;
    for (const entry of readdirSync(dirPath).sort()) {
      const fullPath = join(dirPath, entry);
      // Битый симлинк / отказ в доступе не должен ронять весь скан плагинов
      // (а с ним и bootstrap) — пропускаем с предупреждением.
      let stat: Stats;
      try {
        stat = statSync(fullPath);
      } catch (e) {
        logger?.warn(`Skipping unreadable plugin entry "${fullPath}": ${String(e)}`);
        continue;
      }
      if (stat.isFile()) {
        if (entry.endsWith(".ts") || entry.endsWith(".js")) {
          found.push({ path: fullPath, label: entry });
        }
        continue;
      }
      if (!stat.isDirectory()) continue;
      const entryFile = this.findEntryFile(fullPath);
      if (entryFile) found.push({ path: entryFile, label: `${entry}/${basename(entryFile)}` });
    }
    return found;
  }

  /** Сканирует каталог и регистрирует найденное. Нет каталога — no-op. */
  loadFromDir(
    dirPath: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
    options?: LoadFromDirOptions,
  ): LoadReport {
    const report: LoadReport = { loaded: 0, skipped: 0, failed: 0 };
    for (const { path, label } of this.entryFiles(dirPath, logger)) {
      this.count(this.tryLoad(path, label, pluginManager, logger, options), report);
    }
    return report;
  }

  /**
   * Перезагрузка каталога: сбросить кэш модулей, выгрузить всё, что лежит в
   * каталоге, и загрузить заново.
   *
   * Порядок именно такой: сначала выгрузка (с `onUnload`, чтобы плагин успел
   * закрыть серверы), потом чтение — иначе старый и новый экземпляр жили бы
   * одновременно и дедуп по имени выкинул бы новый.
   *
   * Про сброс кэша: под Bun `delete require.cache` работает и для `.ts`, и для
   * `.js`. Под Node `.js` тоже, а вот `.ts` — нет (модуль Node кэшируется
   * отдельно, через type-stripping). Такие файлы считаем «устаревшими»: плагин
   * выгружен и зарегистрирован заново, но код — старый, нужен рестарт процесса.
   */
  reloadFromDir(
    dirPath: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
    options?: LoadFromDirOptions,
  ): ReloadReport {
    const entries = this.entryFiles(dirPath, logger);
    const unloaded = pluginManager.unloadByDir(dirPath).length;
    for (const { path } of entries) {
      invalidateModuleCache(path, logger);
    }
    pluginManager.clearFailures();
    const report = this.loadFromDir(dirPath, pluginManager, logger, options);
    const staleTs = entries.filter((e) => isStaleAfterInvalidate(e.path)).length;
    logger?.warn(
      t("plugin.reload_done", {
        loaded: String(report.loaded),
        unloaded: String(unloaded),
        failed: String(report.failed),
      }),
    );
    return { unloaded, loaded: report.loaded, failed: report.failed, staleTs };
  }

  /** Разносит исход одной попытки загрузки по счётчикам отчёта. */
  private count(outcome: "loaded" | "skipped" | "failed", report: LoadReport): void {
    report[outcome]++;
  }

  private findEntryFile(dir: string): string | null {
    for (const name of FOLDER_ENTRY_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Гейт по минимальной версии MMA; true — плагин несовместим. */
  private incompatible(plugin: AgentPlugin, options?: LoadFromDirOptions): boolean {
    if (!plugin.minMmaVersion || !options?.mmaVersion) return false;
    if (!semverGt(plugin.minMmaVersion, options.mmaVersion)) return false;
    return true;
  }

  /** Рассказать о результате регистрации (варн + счётчик исхода). */
  private reportResult(
    result: ReturnType<PluginManager["register"]>,
    plugin: AgentPlugin,
    label: string,
    fullPath: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
  ): "loaded" | "skipped" {
    if (result.status === "registered") {
      logger?.warn(t("plugin.loaded", { name: plugin.name }));
      // Мягкие замечания метаданных — один варн на плагин, не на каждый ход.
      for (const warning of result.warnings ?? []) {
        logger?.warn(t("plugin.meta_warning", { name: plugin.name, problem: warning }));
      }
      return "loaded";
    }
    if (result.status === "invalid") {
      logger?.warn(t("plugin.invalid", { name: String(plugin.name), problem: result.errors[0] }));
      pluginManager.noteFailure(label, fullPath, result.errors[0]);
      return "skipped";
    }
    if (result.status === "skipped_older") {
      logger?.warn(
        t("plugin.dedup_older", { name: plugin.name, version: plugin.version || "0.0.0" }),
      );
    }
    return "skipped";
  }

  private tryLoad(
    fullPath: string,
    label: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
    options?: LoadFromDirOptions,
  ): "loaded" | "skipped" | "failed" {
    try {
      const mod = require(fullPath) as { default?: AgentPlugin; plugin?: AgentPlugin };
      const plugin = mod.default || mod.plugin;
      if (!plugin?.name) return "skipped";
      // Путь нужен UI (откуда плагин) и будущему reload (дифф по файлам).
      plugin.path = fullPath;
      if (this.incompatible(plugin, options)) {
        logger?.warn(
          t("plugin.incompatible", {
            name: plugin.name,
            min: String(plugin.minMmaVersion),
            current: String(options?.mmaVersion),
          }),
        );
        return "skipped";
      }
      return this.reportResult(
        pluginManager.register(plugin, options?.source),
        plugin,
        label,
        fullPath,
        pluginManager,
        logger,
      );
    } catch (e: any) {
      logger?.warn(t("plugin.skipped", { entry: label, message: e.message }));
      // Раньше сломанный плагин просто исчезал: отличить «нет такого» от
      // «есть, но падает» было нельзя. Теперь причина попадает в UI.
      pluginManager.noteFailure(label, fullPath, e?.message ?? String(e));
      return "failed";
    }
  }
}
