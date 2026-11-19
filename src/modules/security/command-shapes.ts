// Опасные ФОРМЫ команды: то, что не ловится по имени команды.
// Вынесено из `command-validator.ts` — набор правил растёт, а валидатор не должен
// превращаться в список строковых констант.
import { classifyGitArgv, gitCommandName, parseGitShellCommand } from "../../tools/git-classes";

/**
 * Возвращает причину блокировки или `undefined`, если форма безопасна.
 *
 * Каждая форма исполняет произвольный код или уничтожает данные в обход
 * чёрного списка команд (аудит §4.10/§4.11). git-формы проверяются единым
 * классификатором (INV-G1): destructive в `bash` запрещены outright — в туле
 * `git` те же формы проходят через `approve` (спека 2026-08-08-git-workflow §4).
 */
export function detectDangerousShape(command: string): string | undefined {
  if (/\b(rmdir|rd|del|erase)\b[^|;&]*\/(s|S)\b/.test(command)) {
    return "Recursive delete is blocked";
  }
  for (const argv of parseGitShellCommand(command)) {
    if (classifyGitArgv(argv) === "destructive") {
      return `${gitCommandName(argv)} is blocked in bash — use the git tool with user approval`;
    }
  }
  if (/\bfind\b[^|;&]*-exec\b/.test(command)) {
    return "find -exec is blocked";
  }
  if (/\bxargs\b/.test(command)) {
    return "xargs is blocked";
  }
  if (/\bawk\b[^|;&]*\bsystem\s*\(/.test(command)) {
    return "awk system() is blocked";
  }
  return undefined;
}
