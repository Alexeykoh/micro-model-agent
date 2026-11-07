// История отправленных ходов для стрелок ▲/▼ в композере (`mma web`).
//
// Семантика — как в shell: ▲ подставляет предыдущее отправленное сообщение,
// ▼ — следующее/обратно, а черновик, с которого начали листание, сохраняется
// и возвращается, когда долистали до «самых новых». История per-session:
// текст чужой вкладки не должен залезать в поле.
//
// Чистые функции без DOM: запись (`record`) и шаги (`browseUp`/`browseDown`)
// оперируют записью `{items, cursor, saved}`. Проверка каретки и открытых
// попапов — на стороне композера (`composer.ts`), чтобы этот лист оставался
// тестируемым без happy-dom.
import type { Dict } from "../core/store/types.js";

/** Максимум хранимых сообщений на сессию (кольцо: старое вытесняется). */
export const HISTORY_CAP = 100;

export interface HistoryEntry {
  items: string[];
  /** Позиция курсора листания; -1 — не листаем (поле показывает черновик). */
  cursor: number;
  /** Черновик, сохранённый при первом подъёме — возвращаем на «дно». */
  saved: string;
}

export function createEntry(): HistoryEntry {
  return { items: [], cursor: -1, saved: "" };
}

/**
 * Записать отправленное сообщение. Пустое/пробельное — мимо; полное совпадение
 * с последним — дедуп (повторный «Enter» не плодит копии). Сбрасывает курсор:
 * новая отправленная фраза — начало листания заново.
 */
export function record(entry: HistoryEntry, text: string): void {
  const t = text.trim();
  if (!t) return;
  if (entry.items[entry.items.length - 1] === t) {
    entry.cursor = -1;
    return;
  }
  entry.items.push(t);
  if (entry.items.length > HISTORY_CAP) entry.items.shift();
  entry.cursor = -1;
}

/**
 * Шаг вверх (предыдущее). Возвращает текст для поля или `null`, если старше
 * нечего. При первом подъёме запоминает текущий черновик.
 */
export function browseUp(entry: HistoryEntry, current: string): string | null {
  if (!entry.items.length) return null;
  if (entry.cursor === -1) entry.saved = current;
  const next = entry.cursor === -1 ? entry.items.length - 1 : entry.cursor - 1;
  if (next < 0) return null; // уже на самом старом
  entry.cursor = next;
  return entry.items[next];
}

/** Шаг вниз (следующее). Дошёл до новых — возвращает сохранённый черновик. */
export function browseDown(entry: HistoryEntry): string | null {
  if (entry.cursor === -1) return null; // не листали — ▼ ничего не делает
  const next = entry.cursor + 1;
  entry.cursor = next >= entry.items.length ? -1 : next;
  return entry.cursor === -1 ? entry.saved : entry.items[entry.cursor];
}

// --- Хранилище по key (активная сессия) -------------------------------------

const store = new Map<string, HistoryEntry>();

/** Key истории: активная сессионная вкладка (нет — legacy `""`). */
export function historyKey(tab: Dict | null): string {
  return tab && tab.kind === "session" ? String(tab.id ?? "") : "";
}

function entryFor(key: string): HistoryEntry {
  let e = store.get(key);
  if (!e) {
    e = createEntry();
    store.set(key, e);
  }
  return e;
}

/** Записать отправленный текст в историю ключа. */
export function recordFor(key: string, text: string): void {
  record(entryFor(key), text);
}

/** ▲: предыдущее сообщение для ключа (или null — старше нечего). */
export function upFor(key: string, current: string): string | null {
  return browseUp(entryFor(key), current);
}

/** ▼: следующее (или сохранённый черновик на «дне», или null — не листали). */
export function downFor(key: string): string | null {
  return browseDown(entryFor(key));
}
