/**
 * Детектор секретов для DLP-egress.
 *
 * Отдельный набор паттернов, а не `TARGETED_SECRET_PATTERNS` из `data-sanitizer`:
 * тот набор сделан для *логов* (ломать строку нельзя, лишняя редакция не страшна),
 * а здесь нужен диапазон **значения** и точность — иначе обычный код
 * (`password === confirmPassword`) превращается в `[SECRET]` и модель перестаёт
 * работать (см. спеку `2026-10-20-dlp-secret-masking-precision-design.md`, INV-S1).
 *
 * Форма находки: `start`/`end` — диапазон значения. Идентификатор (`API_KEY=`)
 * остаётся в тексте → маска сохраняет структуру строки (INV-S2).
 */
import type { Finding } from "../types";
import { excludedRanges, overlapsAny } from "../normalize";

/** Символы, допустимые в «сыром» значении: буквы, цифры и разделители. */
const VALUE_CHARS = "A-Za-z0-9_\\-.\\/+~";

/** Идентификаторы ключа, за которыми может стоять секрет. */
const KEY_ID = "(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret[_-]?key|private[_-]?key|client[_-]?secret|secret|password|passwd|pwd)";

/** Известные префиксы секретов: форма однозначна, значение маскируется целиком. */
const KNOWN_PREFIX = /^(?:sk-|ghp_|github_pat_|ctx7sk-|AKIA|xox[baprs]-)/;

/** Один паттерн детектора: диапазон значения и признак «значение в кавычках». */
interface SecretPattern {
  re: RegExp;
  /** Индекс группы со значением (0 — весь матч). */
  valueGroup: number;
  /** Значение взято в кавычки: короткие литералы тоже считаем секретом. */
  quoted: boolean;
  /** Вид находки (в журнал уходит вид класса, не id паттерна). */
  kind: string;
}

/**
 * Паттерны детектора. Порядок важен: более специфичные идут первыми, иначе
 * `key = value` перехватит `Bearer …`.
 */
const PATTERNS: SecretPattern[] = [
  // `api_key = "…"` — значение в кавычках.
  {
    re: new RegExp(`\\b${KEY_ID}\\s*[:=]\\s*(["'])([${VALUE_CHARS}]{6,})\\1`, "gi"),
    valueGroup: 2,
    quoted: true,
    kind: "secret:key",
  },
  // `api_key = …` — значение без кавычек.
  {
    re: new RegExp(`\\b${KEY_ID}\\s*[:=]\\s*([${VALUE_CHARS}]{8,})`, "gi"),
    valueGroup: 1,
    quoted: false,
    kind: "secret:key",
  },
  // `Authorization: Bearer <token>` — маскируется только токен.
  {
    re: /\bBearer\s+([A-Za-z0-9_\-.=+/]{20,})/g,
    valueGroup: 1,
    quoted: false,
    kind: "secret:bearer",
  },
  // JWT.
  {
    re: /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:jwt",
  },
  // Известные префиксы (однозначная форма).
  {
    re: /\bsk-[A-Za-z0-9_\-]{20,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:prefix",
  },
  {
    re: /\bghp_[A-Za-z0-9]{30,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:prefix",
  },
  {
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:prefix",
  },
  {
    re: /\bctx7sk-[A-Za-z0-9_\-]{10,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:prefix",
  },
  {
    re: /\bAKIA[0-9A-Z]{15,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:prefix",
  },
  {
    re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g,
    valueGroup: 0,
    quoted: false,
    kind: "secret:prefix",
  },
];

/**
 * Похоже ли значение на секрет (INV-S1).
 *
 * - известный префикс — всегда;
 * - иначе нужны цифра и буква, плюс длина (длинное непрозрачное значение) либо
 *   разделитель в значении, либо кавычки (короткий литерал вроде `'hunter2'`).
 *
 * Отсюда: `confirmPassword` (без цифры) и `process.env.X` — не секреты;
 * `hunter2` в кавычках и `sk-proj-…` — секреты.
 */
export function looksSecret(value: string, quoted: boolean): boolean {
  if (!value) return false;
  if (KNOWN_PREFIX.test(value)) return true;
  const hasDigit = /\d/.test(value);
  const hasLetter = /[A-Za-z]/.test(value);
  if (!hasDigit || !hasLetter) return false;
  if (quoted) return value.length >= 6;
  if (value.length >= 16) return true;
  return value.length >= 8 && /[._\-+/~]/.test(value);
}

/** Все находки класса `secret` (диапазон — значение, не весь матч). */
export function detectSecrets(text: string): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;
  const excluded = excludedRanges(text);
  for (const p of PATTERNS) {
    // Флаг `d` (hasIndices) — точные смещения группы, без угадывания по подстроке.
    const re = new RegExp(p.re.source, `${p.re.flags}d`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const raw = m[p.valueGroup] ?? m[0];
      const span = m.indices?.[p.valueGroup];
      const start = span ? span[0] : m.index;
      const end = span ? span[1] : m.index + raw.length;
      if (overlapsAny(start, end, excluded)) continue;
      // Форма значения решает: `password === confirmPassword` — не секрет.
      if (p.kind === "secret:key" && !looksSecret(raw, p.quoted)) continue;
      findings.push({
        dataClass: "secret",
        kind: p.kind,
        start,
        end,
        confidence: 1,
        redact: true,
      });
    }
  }
  return findings;
}
