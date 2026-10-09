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
 * Собирает и запускает апдейт. Возвращает `undefined`, когда обновляться нельзя:
 * dev-запуск из чекаута или сборка модуля бросила (автоапдейт best-effort —
 * ронять старт ему нельзя).
 */
export function createUpdater(opts: CreateUpdaterOptions): UpdaterModule | undefined {
  // Dev-прогон грузит TypeScript-исходники; опубликованный бандл — dist/main.js.
  // Из чекаута не автоапдейтимся: его package.json вправе отставать от релиза,
  // а установка поверх юзерской деструктивна.
  if (isDevEntryPath(opts.entryPath)) return undefined;
  try {
    const updater = new Updater(readMmaVersion(), opts.deps);
    const module = new UpdaterModule(
      opts.config,
      updater,
      opts.logger ?? quietLogger(),
      opts.onNotice,
    );
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
    info: (m) => defaultOutputBus.log("info", "updater", m),
    warn: (m) => defaultOutputBus.log("warn", "updater", m),
    error: (m) => defaultOutputBus.log("error", "updater", m),
  };
}