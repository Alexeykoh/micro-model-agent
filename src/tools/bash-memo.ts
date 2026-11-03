/**
 * Мемоизация read-only bash-команд: эвристика мемоизируемости и оборонительный
 * доступ к memo-методам исполнителя. Вынесено из `bash.ts` (правило 6).
 * Само хранение — в ToolExecutor; здесь только вызовы и префиксы.
 */
import type { ToolContext, ToolResult } from "./types";

/**
 * Read-only префиксы для мемоизации (см. `manualMemo` тула). Эвристика,
 * намеренно узкая: одиночные вызовы, немутирующие по построению. Всё составное
 * (`&`, `|`, `<`, `>`, `;`) — никогда в мемо. TTL 120с в исполнителе
 * ограничивает протухание от внешних правок.
 */
const READONLY_COMMAND_PREFIXES = [
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git tag",
  "git rev-parse",
  "git ls-remote",
  "git remote",
  "git show",
  "npm view",
  "npm list",
  "npm config get",
  "npm whoami",
  "npm ping",
  "npm --version",
  "node --version",
  "python --version",
  "python3 --version",
  "bun --version",
  "git --version",
  "dir",
  "ls",
  "echo",
  "type",
  "where",
  "which",
  "cat",
];

const READONLY_COMMAND_PATTERNS = READONLY_COMMAND_PREFIXES.map(
  (p) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`),
);

/**
 * Мемоизируема ли (post-adaptation) команда: одиночный read-only вызов,
 * чей успешный результат можно кешировать. Экспортировано для тестов.
 */
export function isMemoizableCommand(command: string): boolean {
  const cmd = command.trim().toLowerCase();
  if (!cmd || /[|<>;&]/.test(cmd)) return false;
  return READONLY_COMMAND_PATTERNS.some((re) => re.test(cmd));
}

// Оборонительный доступ к мемо: самописные стабы ToolExecutor в тестах (и любой
// будущий минимальный исполнитель) могут не иметь memo-методов — считать промахом.
export function memoRead(
  ctx: ToolContext,
  args: Record<string, unknown>,
): ToolResult | undefined {
  const get = ctx.toolExecutor?.memoGet;
  return typeof get === "function" ? get.call(ctx.toolExecutor, "bash", args) : undefined;
}

export function memoWrite(
  ctx: ToolContext,
  args: Record<string, unknown>,
  result: ToolResult,
): void {
  const set = ctx.toolExecutor?.memoSet;
  if (typeof set === "function") set.call(ctx.toolExecutor, "bash", args, result);
}

export function memoClear(ctx: ToolContext): void {
  const clear = ctx.toolExecutor?.memoInvalidate;
  if (typeof clear === "function") clear.call(ctx.toolExecutor);
}
