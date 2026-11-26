/** BCP-4: убираем устаревшие ошибки из сводки компакции. */

const ERROR_MARKER = /error|failed|✗|ошибк|не удалось|не работает/i;

/** Оставляет только те строки леджера, которые не являются старыми ошибками. */
export function omitStaleErrorLines(lines: readonly string[]): string[] {
  return lines.filter((line) => !ERROR_MARKER.test(line));
}
