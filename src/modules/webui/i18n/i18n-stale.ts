// Детектор протухших i18n-словарей `mma web` (ses_mup6p61q_yoope2).
//
// Кейс: код обновлён на диске (новые ключи в en.json/ru.json), а серверный
// процесс стартовал раньше и держит старый словарь в памяти — браузер
// показывает сырые ключи (`web.usage.part_system`) вместо подписей.
// Сигнал точный и дешёвый: mtime словарей на диске новее старта процесса.
// В npm-dist словарей рядом может не быть — тогда fail-open (false).
import { statSync } from "fs";
import { join } from "path";

const serverStartedAt = Date.now();

const dictFiles = ["en.json", "ru.json"].map((f) =>
  join(import.meta.dirname, "..", "..", "i18n", f),
);

/**
 * True — словари на диске новее старта сервера: запущенному процессу нужен
 * рестарт, иначе клиент видит устаревшие переводы. Проверяется по mtime
 * обоих словарей на каждый вызов (два statSync — дёшево для 2s-полла).
 */
export function isI18nStale(): boolean {
  for (const p of dictFiles) {
    try {
      if (statSync(p).mtimeMs > serverStartedAt) return true;
    } catch {
      // Нет файла (dist-сборка) — не свидетельство протухания.
    }
  }
  return false;
}
