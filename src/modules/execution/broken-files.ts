/**
 * Разбор сломанных компиляцией файлов из вывода write/edit.
 *
 * Вынесено из `execution-plugin.ts` (правило 6): чистые функции разбора.
 */
import { toForwardSlash } from "../../tools/path-utils";

/** Сломанный компиляцией файл ("" — без привязки к файлу). */
export interface BrokenFile {
  file: string;
  error: string;
}

export function normalizeBrokenPath(p: string): string {
  return toForwardSlash(p).replace(/^\.\//, "");
}

/** Парсит строку ошибки tsc / bun build / node --check в путь файла.
 *  Null, если в строке нет привязки к файлу (напр. `error: Could not
 *  resolve "..."`). */
export function parseBrokenFile(line: string): string | null {
  const trimmed = line.trim();
  // tsc: src/index.tsx(17,15): error TS2322: ...
  const tsc = /^(.+?)\s*\(\d+,\d+\)\s*:\s*error TS\d+/.exec(trimmed);
  if (tsc) return normalizeBrokenPath(tsc[1]);
  // bun build / node --check: /abs/file.tsx:1:10: error: ...
  const bn = /^(.+?):\d+:\d+\s*:\s*(?:error|SyntaxError)/.exec(trimmed);
  if (bn) return normalizeBrokenPath(bn[1]);
  return null;
}

/** Вытаскивает пофайловые compile-фейлы из вывода write/edit. Смотрит только
 *  строки-маркеры (`[Project typecheck failed]: <line>` /
 *  `[Syntax check failed]: <line>`), чтобы тело диффа не давало ложных. */
export function extractBrokenFiles(output: string): BrokenFile[] {
  const out: BrokenFile[] = [];
  for (const line of output.split("\n")) {
    const marker = /\[(?:Project typecheck failed|Syntax check failed)\]:\s*(.+)$/.exec(line);
    if (!marker) continue;
    const errLine = marker[1].trim();
    out.push({ file: parseBrokenFile(errLine) ?? "", error: errLine.slice(0, 300) });
  }
  return out;
}

/** Сброс пер-шаговых флагов при смене активного шага (или его отсутствии: -1). */

