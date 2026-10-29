// Web-обвязка проекции host-снапшота: ядро живёт в `src/core/host-state.ts`.
/**
 * Сама проекция фронтендонезависима и вынесена в `core` (её дёргают и `mma web`,
 * и `mma serve`, и будет дёргать TUI). Здесь остаётся только web-специфика:
 * структурные подмножества `IndexerModule`/`LspModule` для сайдбара и вкладок
 * LSP, плюс подстановка web-only флага `i18nStale` (в `core` он опционален —
 * терминалу и сервису показывать нечего).
 */
import { buildHostState as buildHostStateCore } from "../../core/host-state";
import type { HostStateSnapshot, ProjectMapInfo } from "../../core/host";
import type { LspDiagnosis } from "../lsp/diagnose";
import { isI18nStale } from "./i18n/i18n-stale";

export {
  captureUsage,
  liveContextUsage,
  planEventFor,
  type HostStateInput,
  type LiveContextSource,
  type UsageSnapshot,
} from "../../core/host-state";

/** Структурное подмножество индексер-модуля для сайдбара (без жёсткой зависимости). */
export interface WebIndexer {
  buildIndex(): Promise<unknown>;
  stats(): { files: number; symbols: number; tokens: number } | null;
  /** Полная статистика карты (вкладка Map); undefined у старых стабов. */
  mapInfo?(): ProjectMapInfo;
  /** Принудительная пересборка индекса (`POST /api/index`). */
  refresh?(): Promise<unknown>;
  /** Подписка на изменения файлов (вотчер). Есть у `IndexerModule`, нет у стабов. */
  watch?(onSettled?: () => void): void;
  /** Отписка от вотчера. */
  unwatch?(): void;
}

/** Узкое подмножество LSP-модуля для вкладки LSP (`/api/lsp/doctor`). */
export interface WebLsp {
  diagnose(baseDir: string): Promise<LspDiagnosis>;
  /** Живой тумблер глобального LSP. Может отсутствовать у старых стабов. */
  setEnabled?(enabled: boolean): void;
  /** Живой тумблер офлайн-режима. Может отсутствовать у старых стабов. */
  setOffline(offline: boolean): void;
  /** Текущие флаги для ответа `GET /api/lsp/doctor`. */
  getFlags?(): { enabled: boolean; offline: boolean };
  /** Структурная диагностика одного файла (панель, `POST /api/lsp/check`). */
  checkFileForWeb?(
    relPath: string,
    baseDir: string,
  ): Promise<{
    ok: boolean;
    path: string;
    diagnostics: unknown[];
    truncated?: boolean;
    ms?: number;
    error?: string;
  }>;
}

/**
 * `buildHostState` с web-подстановкой: `i18nStale` считается на сервере (словари
 * на диске могут быть новее процесса), остальное — ядро из `core`.
 */
export function buildHostState(
  deps: Parameters<typeof buildHostStateCore>[0],
  busy: boolean,
): HostStateSnapshot {
  return buildHostStateCore({ ...deps, i18nStale: deps.i18nStale ?? isI18nStale() }, busy);
}