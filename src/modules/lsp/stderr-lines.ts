// Хвост stderr упавшего LSP-сервера → строки для отчёта.
//
// Один формат на все поверхности: `/lsp doctor` (с отступом) и
// `[LSP check failed]` в `lsp_check`/веб-панели. Без общего кап-формата каждая
// поверхность резала хвост по-своему, и болтливый сервер мог залить вывод.
//
// Важно: показываем НАЧАЛО и КОНЕЦ, а не первые N строк. Node печатает
// предупреждения (`DEP0190`) до фатальной ошибки, и обрезка «первые 3 строки»
// оставляла пользователя с безобидным warning вместо причины падения.
export const STDERR_TAIL_LINES = 3;
export const STDERR_LINE_MAX = 200;

/**
 * До `maxLines` строк: начало хвоста и его конец (середина схлопывается в «…»).
 * Каждая строка не длиннее `maxLen` символов.
 */
export function stderrTailLines(
  tail: string | undefined,
  maxLines = STDERR_TAIL_LINES,
  maxLen = STDERR_LINE_MAX,
): string[] {
  if (!tail) return [];
  const lines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const picked =
    lines.length <= maxLines
      ? lines
      : maxLines === 1
        ? [lines[lines.length - 1] as string]
        : // первая (что за процесс) + последние (почему умер)
          [lines[0] as string, ...lines.slice(-(maxLines - 1))];
  return picked.map((line) => line.slice(0, maxLen));
}
