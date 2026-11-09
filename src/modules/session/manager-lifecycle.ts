// Lifecycle-хелперы SessionManager (вынесено из manager.ts, потолок 300):
// обновление эффективного окна/модели и touch/active-операции.
import { t } from "../../i18n/index";
import type { SessionManagerOptions } from "./manager-options";
import type { SessionMeta } from "./types";
import type { SessionStore, SessionLogEntry } from "./store";
import type { SessionRead } from "./read-status";

/** Обновляет дефолты окна/модели и мету активной сессии (fail-open). */
export function applyEffectiveContext(
  store: SessionStore,
  options: SessionManagerOptions,
  activeId: string | null,
  contextWindow: number,
  model?: string,
): void {
  options.contextWindow = contextWindow;
  if (model) options.model = model;
  if (!activeId) return;
  const meta = store.loadMeta(activeId);
  if (!meta) return;
  meta.contextWindow = contextWindow;
  if (model) meta.model = model;
  meta.updatedAt = new Date().toISOString();
  store.saveMeta(activeId, meta);
}

/** Обновляет `updatedAt` активной сессии без изменения содержимого. */
export function touchActiveSession(store: SessionStore, activeId: string | null): void {
  if (!activeId) return;
  const meta = store.loadMeta(activeId);
  if (!meta) return;
  meta.updatedAt = new Date().toISOString();
  store.saveMeta(activeId, meta);
}

/** Мета активной сессии (null — нет). */
export function getActiveMetaOf(store: SessionStore, activeId: string | null): SessionMeta | null {
  if (!activeId) return null;
  return store.loadMeta(activeId);
}

/** Чтение session.jsonl сессии (для `session show`); с `since` — только хвост. */
export function readSessionLog(
  store: SessionStore,
  id: string,
  opts: { since?: string } = {},
): SessionLogEntry[] {
  try {
    return store.loadSessionLog(id, opts);
  } catch {
    return [];
  }
}

/** Чтение session.jsonl с причиной на ошибке (не «нет файла»). */
export function readSessionLogWithStatus(
  store: SessionStore,
  id: string,
  opts: { since?: string } = {},
): SessionRead<SessionLogEntry[]> {
  try {
    return store.loadSessionLogWithStatus(id, opts);
  } catch (err) {
    return { status: "unreadable", cause: err instanceof Error ? err.message : String(err) };
  }
}

/** Сделать сессию активной; нет такой — ошибка. */
export function activateSession(
  store: SessionStore,
  setActive: (id: string | null) => void,
  id: string,
): void {
  if (!store.sessionExists(id)) {
    throw new Error(t("session.not_found", { id }));
  }
  setActive(id);
}
