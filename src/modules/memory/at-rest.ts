/**
 * At-rest для памяти (гибрид, решение 2026-11-02): записи, которые дописывает
 * агент, шифруются **на месте**, сохраняя markdown-структуру:
 *
 *   - **2026-11-02 10:00:00** — [enc]BASE64[/enc]
 *
 * Так файл остаётся списком (обрезка, удаление записи, ручные заметки работают),
 * но содержимое авто-записей на диске не читается. Ручные строки пользователя
 * не шифруются — их и только их он видит при открытии файла.
 *
 * Включается тем же `sessionEncryption.enabled`: отдельный флаг не заводим,
 * чтобы «включил защиту на диске» не означало «включил половину».
 */
import type { SessionFileEncryptor } from "../security/session-encryption";

let encryptor: SessionFileEncryptor | null = null;

/** Установить шифратор памяти (bootstrap; null — выключить). */
export function setMemoryEncryptor(next: SessionFileEncryptor | null): void {
  encryptor = next;
}

/** Включено ли шифрование памяти. */
export function memoryAtRestEnabled(): boolean {
  return encryptor?.isEnabled() === true;
}

const BLOCK_RE = /\[enc\]([\s\S]*?)\[\/enc\]/g;

/** Зашифровать одну запись агента; при выключенном режиме — как есть. */
export function encryptMemoryEntry(text: string): string {
  if (!encryptor?.isEnabled() || !text) return text;
  try {
    return `[enc]${encryptor.encryptFileContent(text)}[/enc]`;
  } catch {
    // Fail-open с явным маркером: не теряем запись, но и не врём, что она цела.
    return `${text} [enc-failed]`;
  }
}

/** Расшифровать все блоки в тексте; нерасшифровываемое оставляем как было. */
export function decryptMemoryText(text: string): string {
  if (!encryptor?.isEnabled() || !text.includes("[enc]")) return text;
  return text.replace(BLOCK_RE, (_all, body: string) => {
    try {
      return encryptor!.decryptFileContent(body);
    } catch {
      return "[enc-unreadable]";
    }
  });
}
