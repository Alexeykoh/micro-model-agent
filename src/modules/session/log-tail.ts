// Хвост session-лога: последние строки отдельно от полного `session.jsonl`.
//
// Trace в вебе читает лог инкрементально (по курсору `since`) — перечитывать
// весь лог на каждый полл нельзя (аудит §6.13). Хвост — ускорение чтения,
// источник истины остаётся `session.jsonl`.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** Сколько строк держим в хвосте. */
export const LOG_TAIL_MAX_LINES = 512;

/** Счётчик строк на файл: переписываем хвост раз на 512 строк, а не на каждый. */
const lineCounts = new Map<string, number>();

/**
 * Дописывает строку в хвост, подрезая его до `maxLines`.
 * Ошибка игнорируется: хвост — ускорение, а не источник истины.
 */
export function appendLogTail(
  path: string,
  payload: string,
  maxLines: number = LOG_TAIL_MAX_LINES,
): void {
  try {
    appendFileSync(path, payload, { encoding: "utf-8", mode: 0o600 });
    const count = (lineCounts.get(path) ?? 0) + 1;
    lineCounts.set(path, count);
    if (count <= maxLines) return;
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    writeFileSync(path, `${lines.slice(-maxLines).join("\n")}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    lineCounts.set(path, maxLines);
  } catch {
    /* хвост — ускорение: его сбой не должен ломать лог */
  }
}
