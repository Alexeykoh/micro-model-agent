// Загрузчик плагинов из каталогов: файлы и папки, гейт по minMmaVersion.
import { readdirSync, existsSync, statSync, type Stats } from "fs";
import { join, basename } from "path";
import type { PluginManager } from "./manager";
import { t } from "../../i18n/index";
import { semverGt } from "../updater/checker";
import type { AgentPlugin } from "./types";

/**
 * Кандидаты точки входа для плагинов-папок. Порядок:
 * `plugin.ts` > `plugin.js` > `index.ts` > `index.js`.
 */
const FOLDER_ENTRY_NAMES = ["plugin.ts", "plugin.js", "index.ts", "index.js"];

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
   * Сканирует каталог (файлы .ts/.js и папки с точкой входа).
   * Нет каталога — no-op.
   */
  loadFromDir(
    dirPath: string,
    pluginManager: PluginManager,
    logger?: { warn: (msg: string) => void },
    options?: LoadFromDirOptions,
  ): LoadReport {
    const report: LoadReport = { loaded: 0, skipped: 0, failed: 0 };
    if (!existsSync(dirPath)) return report;

    const entries = readdirSync(dirPath).sort();
    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      // Битый симлинк / отказ в доступе не должен ронять весь скан плагинов
      // (а с ним и bootstrap) — пропускаем с предупреждением.
      let stat: Stats;
      try {
        stat = statSync(fullPath);
      } catch (e) {
        logger?.warn(`Skipping unreadable plugin entry "${fullPath}": ${String(e)}`);
        report.skipped++;
        continue;
      }

      if (stat.isFile()) {
        if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
        this.count(this.tryLoad(fullPath, entry, pluginManager, logger, options), report);
      } else if (stat.isDirectory()) {
        const entryFile = this.findEntryFile(fullPath);
        if (entryFile) {
          this.count(
            this.tryLoad(
              entryFile,
              `${entry}/${basename(entryFile)}`,
              pluginManager,
              logger,
              options,
            ),
            report,
          );
        }
      }
    }
    return report;
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
