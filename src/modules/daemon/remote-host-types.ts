/**
 * Общие типы/хелперы wire-клиента `RemoteHost` (правило ≤300).
 *
 * Вынесено, чтобы `remote-host.ts` описывал запросы, а не повторял мелочи
 * подключения; публичный импорт `RemoteHostOptions` остаётся из `remote-host`.
 */

/** Параметры подключения: адрес демона, сессия, bearer-токен, локаль. */
export interface RemoteHostOptions {
  baseUrl: string;
  sessionId?: string;
  token?: string | null;
  /** Локаль клиента (`X-Mma-Locale`); дефолт — локаль процесса. */
  locale?: string;
}

/** События, после которых ход сессии завершён (busy снимается). */
export const TERMINAL_TYPES = new Set(["task.finished", "task.failed", "task.cancelled"]);

/** Текст ответа без падения на уже закрытом теле. */
export async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
