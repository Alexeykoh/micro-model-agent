/**
 * Unix-команды, которых нет в Windows cmd.exe (или семантика несовместима).
 * 9B-модель тянется к grep/sed/ls/find через тул bash; каждый фейл возвращает
 * хинт, но модель ретраит.
 *
 * Сессионный модульный компаньон пер-командного hard-stop самого тула bash
 * (`UNIX_TO_WIN_HINTS` / `FAILING_FIRST_WORDS` / `HARD_BLOCK_THRESHOLD` в
 * src/tools/bash.ts). Тот механизм инжектит "STOP using X" В вывод тула,
 * который 9B-модель склонна игнорировать; этот, гейченный на win32 как bash.ts,
 * кладёт <system-summary> перед следующим вызовом модели. Списки команд держим
 * синхронно.
 *
 * Это allow/deny-список команд (как чёрный список команд security-модуля),
 * НЕ классификация задач (правило #10).
 */
const FORBIDDEN_COMMANDS = new Set([
  "grep",
  "sed",
  "awk",
  "uniq",
  "xargs",
  "cut",
  "tr",
  "basename",
  "dirname",
  "export",
  "source",
  "sleep",
  "env",
  "ls",
  "find",
  "rm",
  "touch",
  "which",
  "diff",
  "cp",
  "mv",
]);

function firstWord(command: string): string {
  const segs = command.trim().split(/[\s;|&]+/);
  return (segs[0] || "").replace(/[^\w-]/g, "").toLowerCase();
}

/** Имя запрещённой команды, если `command` с неё начинается (понимает `cd x && …`). */
export function forbiddenWindowsCommand(command: string): string | null {
  const m = command.match(/^\s*cd\s+\S+\s*&&\s*(\S+)/);
  if (m) return forbiddenWindowsCommand(m[1]);
  const word = firstWord(command);
  if (word && FORBIDDEN_COMMANDS.has(word)) return word;
  return null;
}
