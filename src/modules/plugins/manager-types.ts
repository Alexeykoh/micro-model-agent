// Типы реестра плагинов. Вынесены из `manager.ts`, чтобы фасад реестра не
// разрастался объявлениями: их читают CLI/REPL/веб через реэкспорт из `./manager`.
import type { AgentPlugin } from "../types";

/**
 * Итог регистрации: `registered` (встал/заменил), `skipped_older` (дедуп по
 * версии), `invalid` (метаданные не прошли проверку), `duplicate` (не
 * возвращается — оставлен для совместимости потребителей типа).
 */
export type RegisterResult =
  | { status: "registered"; warnings?: string[] }
  | { status: "skipped_older"; existing: AgentPlugin }
  | { status: "invalid"; errors: string[] }
  | { status: "duplicate" };

/** Плагин с источником загрузки (для показа в REPL/CLI). */
export interface PluginInfo {
  plugin: AgentPlugin;
  source?: "builtin" | "global" | "project";
}

/** Итог перезагрузки каталога плагинов. */
export interface ReloadReport {
  /** Выгружено плагинов (ушли из реестра, ресурсы освобождены). */
  unloaded: number;
  /** Загружено заново. */
  loaded: number;
  /** Не удалось перечитать (ошибка импорта или несовместимость). */
  failed: number;
  /** Файлы `.ts` под Node: кэш модуля не сбрасывается, нужен рестарт. */
  staleTs: number;
}

/** Каталоги, из которых менеджер читает внешние плагины. */
export interface PluginDirs {
  globalPluginsDir: string;
  projectPluginsDir: string;
}
