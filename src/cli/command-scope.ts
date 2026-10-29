// Какие CLI-команды нуждаются в сессии (A-01). Read-only команды сессию не
// создают; one-shot/REPL (нет подкоманды) и диалоговые поверхности — создают.

/** Команды, которым нужен живой диалог/сессия. */
export const SESSION_COMMANDS: ReadonlySet<string> = new Set(["web", "serve", "meet", "agents"]);

/**
 * Нужна ли сессия этой команде.
 * @param first первая позиционная часть argv (команда или промпт).
 * @param names зарегистрированные имена команд.
 */
export function sessionNeededFor(first: string | undefined, names: ReadonlySet<string>): boolean {
  const knownCommand = first ? names.has(first) : false;
  return !knownCommand || SESSION_COMMANDS.has(first as string);
}
