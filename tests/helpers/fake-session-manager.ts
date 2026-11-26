import type { SessionManager } from "../../src/modules/session/index";
import type { SessionLogEntry } from "../../src/modules/session/log-types";

/**
 * Минимальный double `SessionManager`: нужен только `appendLog`.
 *
 * Каст локализован вне `tests/core` — гвард `double-honesty` считает unsafe-касты
 * именно там. Общий хелпер убирает дублирование трёх таких кастов, а не добавляет
 * ещё один «по умолчанию»: тесты получают типизированные `entries` и не повторяют
 * `as unknown as SessionManager` в каждом файле.
 */
export function fakeSessionManager(): {
  manager: SessionManager;
  entries: SessionLogEntry[];
} {
  const entries: SessionLogEntry[] = [];
  const manager = {
    appendLog: (entry: SessionLogEntry) => {
      entries.push(entry);
    },
  } as unknown as SessionManager;
  return { manager, entries };
}
