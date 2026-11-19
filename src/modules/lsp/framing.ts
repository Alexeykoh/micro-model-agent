// Фрейминг LSP-сообщений: заголовки `Content-Length` + тело. Чистые функции,
// чтобы транспорт (`connection.ts`) оставался плоским, а разбор — тестируемым.
//
// Спека (3.17 "Base Protocol"): заголовки разделяются пустой строкой, длина
// считается в БАЙТАХ. Разделитель у разных серверов встречается `\r\n\r\n`
// (штатно) и `\n\n` (часть реализаций), поэтому принимаем оба, иначе
// LF-only сервер молча упирается в таймаут.

/** Верхняя граница длины одного фрейма (защита от битого/злого сервера). */
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;

/** Паттерн разделителя заголовков и тела: плюрально по переводам строк. */
const HEADER_SEPARATOR = /\r?\n\r?\n/;

/**
 * Индекс начала тела в буфере и длина секции заголовков, либо null если
 * заголовки ещё не доехали целиком.
 */
export function findHeaderEnd(buffer: Buffer): { headerEnd: number; headerLength: number } | null {
  const match = HEADER_SEPARATOR.exec(buffer.toString("utf8", 0, Math.min(buffer.length, 512)));
  if (!match) return null;
  return { headerEnd: match.index + match[0].length, headerLength: match[0].length };
}

/**
 * `Content-Length` из секции заголовков. Терпимо к регистру, лишним пробелам
 * и дополнительным заголовкам (`Content-Type`); нечисловое значение — null.
 */
export function parseContentLength(headers: string): number | null {
  for (const line of headers.split(/\r?\n/)) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (match) {
      const value = Number.parseInt(match[1], 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    }
  }
  return null;
}

/** Приемлема ли длина фрейма (не обрезана, не абсурдна). */
export function isAcceptableFrameLength(length: number): boolean {
  return Number.isInteger(length) && length >= 0 && length <= MAX_FRAME_BYTES;
}
