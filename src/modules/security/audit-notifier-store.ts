// Файловое хранилище audit-нотификаций: append/read/clear + сводка.
// Вынесено из `audit-notifier.ts` (правило 6); нотификатор отвечает за
// фильтрацию/webhook, а IO — здесь.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { defaultOutputBus } from "../../output";
import type {
  AuditEventType,
  AuditNotification,
  AuditSeverity,
} from "./audit-notifier";

/** Файл нотификаций или `undefined` (хранилище отключено). */
export class AuditNotificationStore {
  constructor(private readonly filePath?: string) {
    this.ensureDir();
  }

  get path(): string | undefined {
    return this.filePath;
  }

  /** Гарантировать каталог лога. */
  ensureDir(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Дописать нотификацию; ошибка IO — диагностика, не исключение. */
  write(notification: AuditNotification): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, `${JSON.stringify(notification)}\n`, "utf8");
    } catch (error) {
      defaultOutputBus.log(
        "error",
        "module:audit",
        `[AuditNotifier] Failed to write to file: ${error instanceof Error ? error.message : String(error)}`,
        { persist: true },
      );
    }
  }

  /** Последние N нотификаций; битый файл — пустой список + диагностика. */
  read(limit = 100): AuditNotification[] {
    if (!this.filePath || !existsSync(this.filePath)) return [];
    try {
      const lines = readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => JSON.parse(line) as AuditNotification);
    } catch (error) {
      defaultOutputBus.log(
        "error",
        "module:audit",
        `[AuditNotifier] Failed to read notifications: ${error instanceof Error ? error.message : String(error)}`,
        { persist: true },
      );
      return [];
    }
  }

  /** Очистить файл нотификаций. */
  clear(): void {
    if (this.filePath) writeFileSync(this.filePath, "", "utf8");
  }

  /** Агрегат по severity/типам. */
  stats(): {
    total: number;
    bySeverity: Record<AuditSeverity, number>;
    byType: Record<AuditEventType, number>;
  } {
    const bySeverity: Record<AuditSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    const byType: Record<AuditEventType, number> = {
      tool_call: 0,
      tool_result: 0,
      bash_command: 0,
      file_operation: 0,
      network_request: 0,
      security_block: 0,
      authentication: 0,
      configuration_change: 0,
      session_start: 0,
      session_end: 0,
    };
    const notifications = this.read();
    for (const n of notifications) {
      bySeverity[n.severity] = (bySeverity[n.severity] || 0) + 1;
      byType[n.eventType] = (byType[n.eventType] || 0) + 1;
    }
    return { total: notifications.length, bySeverity, byType };
  }
}
