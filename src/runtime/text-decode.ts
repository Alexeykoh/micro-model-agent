/**
 * Декодирование текстового буфера (split W10): общий шаг для просмотра файлов
 * и поиска по workspace. Живёт в runtime, потому что нужен и вебу, и демону.
 */

/** Декодирует текстовый буфер с учётом BOM UTF-16/UTF-8; NUL в других местах — бинарка. */
export function decodeText(buf: Buffer): { text: string; binary: boolean } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le"), binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // `swap16` отвергает нечётное число байт — свапаем только чётный префикс.
    const body = buf.subarray(2);
    const even = body.length - (body.length % 2);
    const swapped = Buffer.from(body.subarray(0, even));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), binary: false };
  }
  const body =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      ? buf.subarray(3)
      : buf;
  if (body.includes(0)) return { text: "", binary: true };
  return { text: body.toString("utf8"), binary: false };
}
