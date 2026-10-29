// Хвост stderr упавшего LSP-сервера → строки для отчёта.
//
// Один формат на все поверхности: `/lsp doctor` (с отступом) и
// `[LSP check failed]` в `lsp_check`/веб-панели. Без общего кап-формата каждая
// поверхность резала хвост по-своему, и болтливый сервер мог залить вывод.
export const STDERR_TAIL_LINES = 3;
export const STDERR_LINE_MAX = 200;

/** До `maxLines` непустых строк, каждая не длиннее `maxLen` символов. */
export function stderrTailLines(
  tail: string | undefined,
  maxLines = STDERR_TAIL_LINES,
  maxLen = STDERR_LINE_MAX,
): string[] {
  if (!tail) return [];
  return tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map((line) => line.slice(0, maxLen));
}
