// Чистка пустых сессий.
//
// Вынесено из `manager.ts`: правило «сессия пустая» — чистая функция над
// стором (аудит §7.15).
import { existsSync, readdirSync, rmSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { getMessageText } from "../../llm/provider";
import type { SessionStore } from "./store";
import type { SessionMeta, SessionMessage } from "./types";

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

/**
 * Ротация старых сессий: истории старше 30 дней → `.jsonl.gz`, мета marked.
 * Loop live in SessionStore (public API) — delegates here.
 */
export function rotateSessions(store: {
  listSessions(): SessionMeta[];
  loadMeta(id: string): SessionMeta | null;
  saveMeta(id: string, meta: SessionMeta): void;
  archiveHistory(id: string): boolean;
}): void {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  for (const session of store.listSessions().slice()) {
    if (new Date(session.updatedAt) >= thirtyDaysAgo) continue;
    if (!store.archiveHistory(session.id)) continue;
    // Пометить мету, чтобы сессия не выглядела «живой» в списках —
    // иначе gz-сессия рекламирует messageCount > 0.
    const meta = store.loadMeta(session.id);
    if (meta) {
      meta.messageCount = 0;
      meta.rotated = true;
      store.saveMeta(session.id, meta);
    }
  }
}

/**
 * Retention-prune: удалить сессии с `updatedAt` старше `retentionDays`
 * (активную, `excludeId`, не удаляет). Ротация (>30d → .gz) архивирует
 * историю; retention — безвозвратное удаление старых сессий.
 */
export function pruneSessionsByRetention(
  store: SessionStore,
  retentionDays: number,
  excludeId: string | undefined,
  remove: (id: string) => void,
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  for (const s of store.listSessions()) {
    if (s.id === excludeId) continue;
    try {
      if (new Date(s.updatedAt).getTime() < cutoff) {
        remove(s.id);
        deleted.push(s.id);
      }
    } catch {
      // fail-open: пропускаем
    }
  }
  return deleted;
}

/**
 * Каталог-сирота: ровно один вход — пустой каталог `temp` (INV-W4). Так
 * оставался след эагерного создания `temp` в `createSessionContext`. Мета, логи
 * или любые другие файлы означают живую либо оборванную сессию — их не трогаем.
 * Пустой каталог тоже не трогаем: так выглядит `create()` между `mkdirSync` и
 * записью меты.
 */
function isOrphanSessionDir(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length !== 1) return false;
  const only = entries[0];
  if (!only.isDirectory() || only.name !== "temp") return false;
  try {
    return readdirSync(join(dir, "temp"), { withFileTypes: true }).length === 0;
  } catch {
    return false;
  }
}

/**
 * Удалить каталоги-сирот в каталоге хранилища сессий (INV-W4). Консервативно:
 * удаляется только каталог, содержащий ровно один пустой `temp`, поэтому гонка
 * с `create()` исключена — тот пишет мету, а `temp` больше не создаётся заранее.
 *
 * @returns число удалённых каталогов.
 */
export function pruneOrphanSessionDirs(baseDir: string): number {
  if (!existsSync(baseDir)) return 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(baseDir, entry.name);
    if (!isOrphanSessionDir(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Fail-open: каталог занят — останется до следующего прогона.
    }
  }
  return removed;
}
