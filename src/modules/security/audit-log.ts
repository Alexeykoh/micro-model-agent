import { existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { globalAuditNotifier } from "./audit-notifier";

/**
 * Audit log entry structure
 */
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
  reason?: string; // For security blocks
}

let _globalAuditDir = resolve(homedir(), ".mma", "logs");
let _sessionAuditDir: string | null = null;

function getAuditDir(): string {
  return _sessionAuditDir ?? _globalAuditDir;
}

/**
 * Set the session directory for audit logs. When set, all audit entries
 * are written to the session-specific directory instead of the global one.
 */
export function setAuditSessionDir(dir: string): void {
  _sessionAuditDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Clear the session directory — fall back to global audit dir.
 */
export function clearAuditSessionDir(): void {
  _sessionAuditDir = null;
}

/**
 * Set the global audit log directory (used when no session dir is active).
 */
export function setGlobalAuditDir(dir: string): void {
  _globalAuditDir = dir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write an audit log entry
 */
export function logAudit(entry: AuditLogEntry): void {
  const dir = getAuditDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  try {
    const logEntry = JSON.stringify(entry);
    appendFileSync(join(dir, "audit.jsonl"), `${logEntry}\n`, "utf8");
  } catch {
    // Silently fail if we can't write to audit log
    // This shouldn't break the agent
  }

  // Notify audit notifier if enabled
  try {
    globalAuditNotifier.notify(entry);
  } catch {
    // Silently fail if notification fails
  }
}

/**
 * Log a tool call
 */
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

/**
 * Log a file write operation
 */
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

/**
 * Log a file delete operation
 */
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

/**
 * Log a bash command execution
 */
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

/**
 * Log a network request
 */
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

/**
 * Log a security block event
 */
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
