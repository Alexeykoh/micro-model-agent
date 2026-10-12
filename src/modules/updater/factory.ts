/**
 * Общая фабрика апдейтера для терминала и `mma web`.
 *
 * Раньше код жил в `cli/main.ts` как `startAutoUpdate`, поэтому веб-режим (где
 * `exitOnComplete=true`) его не касался — и переключатели `updater.*` в панели
 * настроек были мёртвыми. Здесь одна точка сборки: dev-гард, чтение версии и
 * проброс уведомлений одинаковы для обеих поверхностей.
 */
import { readMmaVersion } from "../../core/version";
import { defaultOutputBus } from "../../output";
import { isDevEntryPath } from "./dev-detect";
import { Updater, type UpdaterDeps } from "./checker";
import { UpdaterModule, type UpdaterLogger, type UpdateNotice } from "./module";
import type { UpdaterConfig } from "../../config/types";

export type { UpdatePhase, UpdateNotice } from "./module";

/** Имя пакета (для чтения CHANGELOG рядом с установкой). */
export const UPDATE_PACKAGE = "micro-models-agent";

/** Вход фабрики: конфиг + путь точки входа + хуки поверхности. */
export interface CreateUpdaterOptions {
  config: UpdaterConfig;
  /** Путь текущей точки входа — по нему определяется dev-запуск. */
  entryPath: string;
  /** Куда уходят уведомления (веб: SSE-шина). Терминал — только `logger`. */
  onNotice?: (notice: UpdateNotice) => void;
  /** Логгер терминала; по умолчанию — no-op (веб не печатает в stdout). */
  logger?: UpdaterLogger;
  /** Инжектируемые зависимости апдейтера (тесты, кастомные окружения). */
  deps?: UpdaterDeps;
}

/**
 * Собирает и запускает апдейт. Возвращает `undefined`, только если сборка модуля
 * бросила (автоапдейт best-effort — ронять старт ему нельзя).
 *
 * Dev-прогон (TypeScript-точка входа, чекаут) НИКОГДА не самообновляется:
 * установка поверх пользовательского глобала из dev-дерева деструктивна. Но
 * проверку и уведомление не глушим — иначе `bun run mma web` молчит об апдейте
 * совсем (и разработчик не видит, что вышел релиз). Гейтим только установку
 * (`setInstallEnabled(false)`), проверка остаётся.
 */
export function createUpdater(opts: CreateUpdaterOptions): UpdaterModule | undefined {
  const dev = isDevEntryPath(opts.entryPath);
  try {
    const updater = new Updater(readMmaVersion(), opts.deps);
    const module = new UpdaterModule(
      opts.config,
      updater,
      opts.logger ?? quietLogger(),
      opts.onNotice,
    );
    if (dev) module.setInstallEnabled(false);
    module.start();
    return module;
  } catch {
    return undefined;
  }
}

/** Логгер-заглушка: веб не печатает в stdout, уведомления уходят в SSE. */
function quietLogger(): UpdaterLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Логгер терминала поверх `OutputBus`. Раньше он жил инлайном в `main.ts`;
 * вынесен, чтобы веб и терминал собирали апдейтер одинаково.
 */
export function busLogger(): UpdaterLogger {
  return {
    info: (m) => defaultOutputBus.log("info", "module:updater", m),
    warn: (m) => defaultOutputBus.log("warn", "module:updater", m),
    error: (m) => defaultOutputBus.log("error", "module:updater", m),
  };
}