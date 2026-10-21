// Файловые операции с логом сессии: запись с ротацией, чтение с отметкой
// оборванного хвоста.
//
// Вынесено из `store.ts`: работа с файлами лога — самостоятельный шов
// (аудит §4.14/§7.14).
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync } from "fs";
import { appendLogTail } from "./log-tail";
import type { SessionFileEncryptor } from "../security/session-encryption";
import type { SessionLogEntry } from "./store";

/** Порог ротации session.jsonl (старый лог уезжает в .jsonl.1). */
export const SESSION_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Дописывает запись в лог и в его хвост. Лог больше порога — уезжает в
 * `session.jsonl.1` (предыдущий .1 затирается): лог растёт всю жизнь сессии
 * и без ротации съедает место (аудит §7.14).
 */
export function appendLogEntry(
  logPath: string,
  tailPath: string,
  entry: SessionLogEntry,
  encryptor?: SessionFileEncryptor | null,
): void {
  const line = JSON.stringify(entry);
  const payload = encryptor?.isEnabled()
    ? `${encryptor.encryptFileContent(line)}\n`
    : `${line}\n`;
  rotateIfLarge(logPath);
  appendFileSync(logPath, payload, { encoding: "utf-8", mode: 0o600 });
  // Хвост: последние строки лога отдельно — по нему Trace читает инкрементально.
  appendLogTail(tailPath, payload);
}

/** Ротация: файл лога больше порога → `session.jsonl.1`. */
function rotateIfLarge(logPath: string): void {
  try {
    if (!existsSync(logPath) || statSync(logPath).size < SESSION_LOG_MAX_BYTES) return;
    const previous = `${logPath}.1`;
    if (existsSync(previous)) rmSync(previous, { force: true });
    renameSync(logPath, previous);
  } catch {
    // Ротация — улучшение: сбой не должен ломать запись лога.
  }
}

/**
 * Читает записи лога. Оборванная последняя строка (обрыв записи при падении) —
 * это потеря данных: помечаем результат флагом `truncatedTail` (аудит §4.14).
 */
export function readLogEntries(
  logPath: string,
  encryptor?: SessionFileEncryptor | null,
): (SessionLogEntry[] & { truncatedTail?: boolean }) | null {
  if (!existsSync(logPath)) return null;
  try {
    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const decrypted = encryptor?.isEnabled() ? decryptLines(lines, encryptor) : lines;
    const entries: (SessionLogEntry[] & { truncatedTail?: boolean }) = decrypted
      .map((line) => {
        try {
          return JSON.parse(line) as SessionLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is SessionLogEntry => e !== null);
    if (raw.length > 0 && !raw.endsWith("\n")) entries.truncatedTail = true;
    return entries;
  } catch {
    return null;
  }
}

/** Расшифровать строки лога (битые — отбрасываем). */
function decryptLines(lines: string[], encryptor: SessionFileEncryptor): string[] {
  return lines
    .map((line) => {
      try {
        return encryptor.decryptFileContent(line);
      } catch {
        return null;
      }
    })
    .filter((l): l is string => l !== null);
}
