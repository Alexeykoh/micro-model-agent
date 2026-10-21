// Опасные ФОРМЫ команды: то, что не ловится по имени команды.
// Вынесено из `command-validator.ts` — набор правил растёт, а валидатор не должен
// превращаться в список строковых констант.

/**
 * Возвращает причину блокировки или `undefined`, если форма безопасна.
 *
 * Каждая форма исполняет произвольный код или уничтожает данные в обход
 * чёрного списка команд (аудит §4.10/§4.11).
 */
export function detectDangerousShape(command: string): string | undefined {
  if (/\b(rmdir|rd|del|erase)\b[^|;&]*\/(s|S)\b/.test(command)) {
    return "Recursive delete is blocked";
  }
  if (/\bgit\s+clean\b[^|;&]*(--force|-[a-zA-Z]*[fxd])/.test(command)) {
    return "git clean with force flags is blocked";
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
