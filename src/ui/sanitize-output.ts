// Санитизация вывода перед показом человеку: терминальные escape-последовательности,
// bidi-override и zero-width символы.
//
// Зачем: вывод тула/модели — это недоверенный текст. OSC 52 пишет в буфер
// обмена, DCS/APC могут дёрнуть терминальный протокол, а bidi-override
// (U+202E) и zero-width символы позволяют скрыть часть текста или подменить
// его вид. Правило 5 AGENTS: каждое правило получает проверку —
// `tests/ui/output-sanitize.test.ts`.

/** OSC/DCS/APC-последовательности (завершаются BEL или ESC \\). */
const ANSI_OSC = /\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g;

/** Bidi-override и zero-width символы (U+202A–202E, U+2066–2069, U+200B–200F, FEFF). */
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g;

/** Управляющие символы C0/C1, кроме табуляции, перевода строки, возврата каретки и ESC. */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;

/** Осиротевший ESC (не начало CSI) — мусор, который терминал покажет как есть. */
const STRAY_ESC = /\x1b(?!\[)/g;

/**
 * Чистит текст от опасных для терминала и глаз последовательностей.
 * Обычные ANSI-цвета (CSI) сохраняются — их использует сам рендерер.
 */
export function sanitizeOutput(text: string): string {
  return text
    .replace(ANSI_OSC, "")
    .replace(BIDI, "")
    .replace(CONTROL, "")
    .replace(STRAY_ESC, "");
}

/**
 * То же, но без ANSI-цветов вообще: для поверхностей без терминала (веб),
 * где escape-коды стали бы буквальным мусором.
 */
export function sanitizeOutputPlain(text: string): string {
  return sanitizeOutput(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

/** Только escape-последовательности OSC/DCS/APC — без bidi и control-символов. */
export function stripTerminalSequences(text: string): string {
  return text.replace(ANSI_OSC, "");
}
