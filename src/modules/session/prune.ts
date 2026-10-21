// Чистка пустых сессий.
//
// Вынесено из `manager.ts`: правило «сессия пустая» — чистая функция над
// стором (аудит §7.15).
import { getMessageText } from "../../llm/provider";
import type { SessionStore } from "./store";
import type { SessionMessage } from "./types";

/**
 * Пустая ли сессия (нет user-сообщения с текстом).
 * Fail-open: ошибка чтения истории — сессия НЕ пустая (лучше оставить).
 */
export function isEmptySession(
  store: SessionStore,
  id: string,
  getHistory: (id: string) => SessionMessage[],
): boolean {
  const meta = store.loadMeta(id);
  if (!meta) return false;
  if ((meta.messageCount ?? 0) === 0) return true;
  let history: SessionMessage[];
  try {
    history = getHistory(id);
  } catch {
    return false;
  }
  return !history.some((m) => m.role === "user" && getMessageText(m.content).trim().length > 0);
}

/**
 * Удалить все пустые сессии, кроме `excludeId`. Вернуть удалённые id.
 * Не бросает: нечитаемые сессии пропускаются.
 */
export function pruneEmptySessions(
  store: SessionStore,
  excludeId: string | undefined,
  remove: (id: string) => void,
): string[] {
  const deleted: string[] = [];
  for (const s of store.listSessions()) {
    if (s.id === excludeId) continue;
    try {
      if (isEmptySession(store, s.id, (sid) => store.loadHistory(sid))) {
        remove(s.id);
        deleted.push(s.id);
      }
    } catch {
      // fail-open: нечитаемые пропускаем
    }
  }
  return deleted;
}
