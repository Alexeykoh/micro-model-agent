/**
 * Логгер плагинной подсистемы. Ставит `PluginManager` из `ModuleCtx`: файловые
 * каталоги и источник `module:plugins` живут у bootstrap-логгера, а не у
 * модульного логгера без каталогов, чьи записи терялись.
 */
import type { Logger } from "../../logger/app-logger";
import { defaultOutputBus } from "../../output/bus";

/** Минимум, который нужен плагинной подсистеме. */
export interface PluginLog {
  warn(msg: string, meta?: Record<string, unknown>): void;
  diagnostic(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void;
}

let current: Logger | null = null;

/** Лёгкие тестовые менеджеры без проводки всё равно видят сигнал в шине. */
const busLog: PluginLog = {
  warn: (msg, meta) => {
    defaultOutputBus.log("warn", "module:plugins", msg, { diagnostic: true, ...meta });
  },
  diagnostic: (level, msg, meta) => {
    defaultOutputBus.log(level, "module:plugins", msg, { diagnostic: true, ...meta });
  },
};

/** Подключить логгер модуля (вызывает конструктор `PluginManager`). */
export function setPluginLogger(logger: Logger | null | undefined): void {
  current = logger ?? null;
}

/** Текущий логгер; без проводки — шина (терминал), не тишина. */
export function pluginLogger(): PluginLog {
  return current ?? busLog;
}
