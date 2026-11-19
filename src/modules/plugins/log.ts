/**
 * Логгер плагинной подсистемы. Приходит из bootstrap (`ModuleCtx`/конструктор
 * `PluginManager`) и принадлежит конкретному менеджеру.
 *
 * Раньше логгер был глобальным «текущим»: любой `new PluginManager()` (в том
 * числе лёгкий менеджер субагента или pipeline) перетирал его, и предупреждения
 * одного менеджера уезжали в каталог чужой сессии — или терялись совсем.
 */
import type { Logger } from "../../logger/app-logger";
import { defaultOutputBus } from "../../output/bus";

/** Минимум, который нужен плагинной подсистеме. */
export interface PluginLog {
  warn(msg: string, meta?: Record<string, unknown>): void;
  diagnostic(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void;
}

/** Источник логгера: всё, что умеет `warn`/`diagnostic` (в т.ч. `Logger`). */
export type PluginLogSource = Pick<Logger, "warn" | "diagnostic">;

/**
 * Лёгкие тестовые менеджеры без проводки всё равно видят сигнал в шине.
 * Шина — терминал, но не тишина: причина отказа не теряется.
 */
const busLog: PluginLog = {
  warn: (msg, meta) => {
    defaultOutputBus.log("warn", "module:plugins", msg, { diagnostic: true, ...meta });
  },
  diagnostic: (level, msg, meta) => {
    defaultOutputBus.log(level, "module:plugins", msg, { diagnostic: true, ...meta });
  },
};

/** Логгер конкретного менеджера: свой на каждый `PluginManager`. */
export function createPluginLog(logger?: PluginLogSource | null): PluginLog {
  if (!logger) return busLog;
  return {
    warn: (msg, meta) => logger.warn(msg, meta),
    diagnostic: (level, msg, meta) => logger.diagnostic(level, msg, meta),
  };
}
