/**
 * Общие типы серверного реестра slash-команд (split W12): одна точка
 * исполнения для CLI-демона, thin-REPL и web-адаптера.
 */
import type { HostCommandResult } from "../../../core/host";
import type { AgentServiceState } from "../state";

/** Вход хендлера: состояние демона и сессия-владелец команды. */
export interface CommandCtx {
  s: AgentServiceState;
  sessionId: string;
}

/** Хендлер команды: строки вывода + `ok`. */
export type CommandHandler = (
  ctx: CommandCtx,
  args: string[],
) => Promise<HostCommandResult> | HostCommandResult;

/** Успешный ответ строками. */
export function ok(...lines: string[]): HostCommandResult {
  return { ok: true, output: lines };
}

/** Ошибка команды (пользователь видит текст, модель — строку). */
export function fail(error: string): HostCommandResult {
  return { ok: false, output: [], error };
}
