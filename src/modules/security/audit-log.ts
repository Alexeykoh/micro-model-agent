// Аудит-лог: запись действий агента в audit.jsonl (глобально или в каталог сессии).
import { existsSync, mkdirSync, appendFileSync } from "fs";
import { globalAuditNotifier } from "./audit-notifier";
import { auditLogFile, globalLogsDir } from "../../config/paths";

/** Запись аудита: кто/что/когда, успех, причина блокировки. */
export interface AuditLogEntry {
  timestamp: string;
  sessionId?: string;
  action:
    | "tool_call"
    | "file_read"
    | "file_write"
    | "file_delete"
    | "bash_command"
    | "network_request"
    | "security_block";
  tool?: string;
  path?: string;
  command?: string;
  url?: string;
  success: boolean;
  details?: string;
  reason?: string; // причина блокировки (для security_block)
}

let _globalAuditDir = globalLogsDir();
let _sessionAuditDir: string | null = null;

function getAuditDir(): string {
  return _sessionAuditDir ?? _globalAuditDir;
}

/**
 * Назначить каталог аудита для сессии: записи идут туда вместо глобального.
 */
export function setAuditSessionDir(dir: string): void {
  _sessionAuditDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** Сбросить каталог сессии — возврат к глобальному каталогу аудита. */
export function clearAuditSessionDir(): void {
  _sessionAuditDir = null;
}

/** Назначить глобальный каталог аудита (когда каталог сессии не активен). */
export function setGlobalAuditDir(dir: string): void {
  _globalAuditDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Записать запись аудита в audit.jsonl и уведомить notifier.
 * Ошибки записи/уведомления глушатся — аудит не должен ронять агента.
 */
export function logAudit(entry: AuditLogEntry): void {
  const dir = getAuditDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  try {
    const logEntry = JSON.stringify(entry);
    appendFileSync(auditLogFile(dir), `${logEntry}\n`, "utf8");
  } catch {
    // молча: невозможность записи не должна ломать агента
  }

  // Уведомить нотификатор аудита, если включён
  try {
    globalAuditNotifier.notify(entry);
  } catch {
    // молча: падение нотификации не должно ломать агента
  }
}

/** Залогировать вызов тула. */
export function logToolCall(
  sessionId: string | undefined,
  tool: string,
  success: boolean,
  details?: string,
): void {
  logAudit({
    timestamp: new Date().toISOString(),
    sessionId,
    action: "tool_call",
    tool,
    success,
    details,
  });
}

/** Залогировать запись файла. */
export function logFileWrite(
  sessionId: string | undefined,
  path: string,
  success: boolean,
  details?: string,
): void {
  logAudit({
    timestamp: new Date().toISOString(),
    sessionId,
    action: "file_write",
    path,
    success,
    details,
  });
}

/** Залогировать удаление файла. */
export function logFileDelete(
  sessionId: string | undefined,
  path: string,
  success: boolean,
  details?: string,
): void {
  logAudit({
    timestamp: new Date().toISOString(),
    sessionId,
    action: "file_delete",
    path,
    success,
    details,
  });
}

/** Залогировать выполнение bash-команды. */
export function logBashCommand(
  sessionId: string | undefined,
  command: string,
  success: boolean,
  details?: string,
): void {
  logAudit({
    timestamp: new Date().toISOString(),
    sessionId,
    action: "bash_command",
    command,
    success,
    details,
  });
}

/** Залогировать сетевой запрос. */
export function logNetworkRequest(
  sessionId: string | undefined,
  url: string,
  success: boolean,
  details?: string,
): void {
  logAudit({
    timestamp: new Date().toISOString(),
    sessionId,
    action: "network_request",
    url,
    success,
    details,
  });
}

/** Залогировать срабатывание security-блока. */
export function logSecurityBlock(
  sessionId: string | undefined,
  _action:
    "tool_call" | "file_read" | "file_write" | "file_delete" | "bash_command" | "network_request",
  reason: string,
  details?: string,
): void {
  logAudit({
    timestamp: new Date().toISOString(),
    sessionId,
    action: "security_block",
    success: false,
    reason,
    details,
  });
}
