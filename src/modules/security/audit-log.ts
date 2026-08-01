import { writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { globalAuditNotifier } from "./audit-notifier";

/**
 * Audit log entry structure
 */
export interface AuditLogEntry {
  timestamp: string;
  sessionId?: string;
  action: "tool_call" | "file_read" | "file_write" | "file_delete" | "bash_command" | "network_request" | "security_block";
  tool?: string;
  path?: string;
  command?: string;
  url?: string;
  success: boolean;
  details?: string;
  reason?: string; // For security blocks
}

/**
 * Directory and file path for audit logs
 */
const AUDIT_LOG_DIR = resolve(homedir(), ".mma", "logs");
const AUDIT_LOG_PATH = resolve(AUDIT_LOG_DIR, "audit.jsonl");

/**
 * Ensure audit log directory exists
 */
function ensureAuditLogDir(): void {
  if (!existsSync(AUDIT_LOG_DIR)) {
    mkdirSync(AUDIT_LOG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Write an audit log entry
 */
export function logAudit(entry: AuditLogEntry): void {
  ensureAuditLogDir();
  
  try {
    const logEntry = JSON.stringify(entry);
    appendFileSync(AUDIT_LOG_PATH, logEntry + "\n", "utf8");
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
  action: "tool_call" | "file_read" | "file_write" | "file_delete" | "bash_command" | "network_request",
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
