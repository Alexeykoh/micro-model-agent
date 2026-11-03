// IO-обвязка SessionLogger: каталог сессии, проверка session_start и записи
// истории (appendMessage). Вынесено (правило 6), чтобы логгер остался
// оркестратором, а формат сообщений истории жил в одном месте.
import type { SessionManager } from "../modules/session/manager";
import type { SessionMessage } from "../modules/session/types";
import type { Logger } from "../logger/app-logger";
import { setAuditSessionDir } from "../modules/security/audit-log";

/** Привязывает логгер приложения и аудит-лог к каталогу активной сессии. */
export function bindSessionLog(
  session: SessionManager | undefined,
  logger: Logger | undefined,
): void {
  const meta = session?.getActiveMeta();
  if (!session || !meta) return;

  const dir = session.getSessionDirectory(meta.id);

  if (logger) {
    logger.setSessionDir(dir);
    logger.initSessionLog(meta.id);
  }

  setAuditSessionDir(dir, meta.id);
}

/**
 * Уже есть `session_start` в логе (его мог записать REPL с LSP-пробой)?
 * Чтение через decrypt-aware store: при шифровании сессии строки на диске —
 * шифртекст, поэтому проверка подстрокой никогда не срабатывала и дубль
 * дописывался. Ошибка чтения — считаем, что записи нет.
 */
export function sessionStartAlreadyLogged(session: SessionManager | undefined): boolean {
  const meta = session?.getActiveMeta();
  if (!meta) return false;
  try {
    return session!.loadSessionLog(meta.id).some((e) => e.type === "session_start");
  } catch {
    return false;
  }
}

/** Сообщение истории для пользователя (текст уже санитизирован). */
export function userMessage(content: string): SessionMessage {
  return { role: "user", content, timestamp: new Date().toISOString() };
}

/** Сообщение истории для ответа ассистента (+provenance провайдера/модели). */
export function assistantMessage(
  content: string,
  caller: { provider?: string; model?: string } | undefined,
): SessionMessage {
  return {
    role: "assistant",
    content,
    timestamp: new Date().toISOString(),
    provider: caller?.provider,
    model: caller?.model,
  };
}

/** Сообщение истории для результата тула (+provenance провайдера/модели). */
export function toolMessage(
  name: string,
  content: string,
  caller: { provider?: string; model?: string } | undefined,
): SessionMessage {
  return {
    role: "tool",
    content,
    name,
    timestamp: new Date().toISOString(),
    provider: caller?.provider,
    model: caller?.model,
  };
}
