/**
 * Идентификаторы сессий. Случайная часть — `crypto.randomBytes`, а не
 * `Math.random`: при одном общем bearer-токене предсказуемые id перебираются.
 *
 * Формат: `ses_<8 time36>_<16 latin>`. Суффикс — только строчные латинские
 * буквы без цифр: длинные цифровые серии (`\d{10}`) детектор PII принимает за
 * паспорт/ИНН и заменяет в ответах API на `<PII:…>`, ломая идентификатор.
 * Старые id (`ses_<time36>_<6 base36>`) остаются валидными: id — непрозрачная
 * строка, а не разбираемый контракт.
 */
import { randomBytes } from "node:crypto";

/** Алфавит суффикса: без цифр, чтобы id не выглядел персональными данными. */
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const SUFFIX_LEN = 16;

/** Случайный суффикс (без цифровых серий, см. шапку модуля). */
function randomSuffix(): string {
  const bytes = randomBytes(SUFFIX_LEN);
  let out = "";
  for (let i = 0; i < SUFFIX_LEN; i++) out += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length];
  return out;
}

/** Новый непредсказуемый id сессии. */
export function newSessionId(now = Date.now()): string {
  return `ses_${now.toString(36).padStart(8, "0")}_${randomSuffix()}`;
}
