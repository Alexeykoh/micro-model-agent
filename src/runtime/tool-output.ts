// Потуловые капы тела результата для транспорта (web SSE и service envelopes).

/**
 * Длинный вывод (логи bash, чтения файлов, хиты поиска) режется, чтобы одно
 * событие не раздуло сокет и ленту; маркер честно фиксирует обрезку.
 */
const TOOL_OUTPUT_CAPS: Record<string, number> = {
  browser: 8000,
  web_search: 6000,
  web_fetch: 4000,
  web_browse: 4000,
  bash: 16000,
  read_file: 12000,
  list_dir: 4000,
  grep: 4000,
  glob: 2000,
  download_file: 2000,
};
const DEFAULT_OUTPUT_CAP = 6000;

/** Обрезает вывод тула по капу; маркер показывает исходную длину. */
export function clipToolOutput(toolName: string, output: string): string {
  const cap = TOOL_OUTPUT_CAPS[toolName] ?? DEFAULT_OUTPUT_CAP;
  if (output.length <= cap) return output;
  return `${output.slice(0, cap)}\n… [truncated from ${output.length.toLocaleString()} chars]`;
}
