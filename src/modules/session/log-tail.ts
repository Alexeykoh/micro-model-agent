// Хвост session-лога: последние строки отдельно от полного `session.jsonl`.
//
// Trace в вебе читает лог инкрементально (по курсору `since`) — перечитывать
// весь лог на каждый полл нельзя (аудит §6.13). Хвост — ускорение чтения,
// источник истины остаётся `session.jsonl`.
//
// Хвост ограничен И строками, И байтами: запись может быть крупной (событие с
// большим payload), и кольцо по строкам тогда разрослось бы на сотни мегабайт.
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";

/** Сколько строк держим в хвосте. */
export const LOG_TAIL_MAX_LINES = 512;

/** Сколько байт максимум занимает хвост. */
export const LOG_TAIL_MAX_BYTES = 512 * 1024;

/** Счётчики по файлу: строки и байты (нужны, чтобы не перечитывать файл). */
const stats = new Map<string, { lines: number; bytes: number }>();

/**
 * Дописывает строку в хвост и подрезает его по бюджету (строки + байты).
 * Ошибка игнорируется: хвост — ускорение, а не источник истины.
 */
export function appendLogTail(
  path: string,
  payload: string,
  maxBytes: number = LOG_TAIL_MAX_BYTES,
  maxLines: number = LOG_TAIL_MAX_LINES,
): void {
  try {
    appendFileSync(path, payload, { encoding: "utf-8", mode: 0o600 });
    const stat = stats.get(path) ?? { lines: 0, bytes: 0 };
    const lines = stat.lines + 1;
    const bytes = stat.bytes + Buffer.byteLength(payload);
    stats.set(path, { lines, bytes });
    if (bytes <= maxBytes && lines <= maxLines) return;
    trimTail(path, maxBytes, maxLines);
  } catch {
    /* хвост — ускорение: его сбой не должен ломать лог */
  }
}

/** Переписывает хвост: последние строки в пределах бюджета байт и строк. */
function trimTail(path: string, maxBytes: number, maxLines: number): void {
  const all = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(all[i]) + 1;
    if (bytes + size > maxBytes && kept.length > 0) break;
    kept.unshift(all[i]);
    bytes += size;
    if (kept.length >= maxLines) break;
  }
  writeFileSync(path, `${kept.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
  stats.set(path, { lines: kept.length, bytes });
}

/** Сбросить счётчики (после удаления файла). */
export function resetLogTailStats(): void {
  stats.clear();
}

/** Текущий размер хвоста в байтах (для тестов/диагностики). */
export function logTailSize(path: string): number {
  const stat = stats.get(path);
  if (stat) return stat.bytes;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
