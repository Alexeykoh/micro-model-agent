// Нотификации о security-событиях: файл + webhook с ретраями и очередью.
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { AuditLogEntry } from "./audit-log";
import { backoffDelay } from "../../utils/retry";
import { defaultOutputBus } from "../../output";

// Глобальный fetch (есть в Bun)
declare const fetch: (url: string, options?: RequestInit) => Promise<Response>;

/** Конфиг нотификаций аудита. */
export interface AuditNotifierConfig {
  /** Включить нотификации */
  enabled: boolean;
  /** Файл лога нотификаций. Дефолт: ~/.mma/logs/audit-notifications.jsonl */
  filePath?: string;
  /** Webhook URL для realtime-нотификаций */
  webhookUrl?: string;
  /** Таймаут webhook в мс. Дефолт: 5000 */
  webhookTimeout?: number;
  /** Минимальная severity для нотификации: 'low' | 'medium' | 'high' | 'critical' */
  minSeverity?: AuditSeverity;
  /** Типы событий для нотификации */
  eventTypes?: AuditEventType[];
  /** Ретраев при падении webhook. Дефолт: 3 */
  maxRetries?: number;
}

/** Уровни severity аудит-событий. */
export type AuditSeverity = "low" | "medium" | "high" | "critical";

/** Типы аудит-событий. */
export type AuditEventType =
  | "tool_call"
  | "tool_result"
  | "bash_command"
  | "file_operation"
  | "network_request"
  | "security_block"
  | "authentication"
  | "configuration_change"
  | "session_start"
  | "session_end";

/** Запись нотификации аудита. */
export interface AuditNotification {
  timestamp: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  message: string;
  details?: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
}

/** Веса severity для сравнения. */
const SEVERITY_WEIGHTS: Record<AuditSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Дефолтный конфиг нотификатора (выключен). */
export const DEFAULT_AUDIT_NOTIFIER_CONFIG: AuditNotifierConfig = {
  enabled: false,
  filePath: join(globalLogsDir(), "audit-notifications.jsonl"),
  webhookTimeout: 5000,
  minSeverity: "medium",
  eventTypes: [
    "security_block",
    "bash_command",
    "file_operation",
    "network_request",
    "authentication",
    "configuration_change",
  ],
  maxRetries: 3,
};

/** Нотификатор security-событий: файл + webhook с ретраями. */
export class AuditNotifier {
  private config: AuditNotifierConfig;
  private retryQueue: Array<{ entry: AuditNotification; retries: number }> = [];
  private isProcessing: boolean = false;

  constructor(config?: Partial<AuditNotifierConfig>) {
    this.config = { ...DEFAULT_AUDIT_NOTIFIER_CONFIG, ...config };
    this.ensureLogDirectory();
  }

  /** Включён ли нотификатор. */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Включить нотификатор. */
  enable(): void {
    this.config.enabled = true;
  }

  /** Выключить нотификатор. */
  disable(): void {
    this.config.enabled = false;
  }

  /** Обновить конфиг. */
  updateConfig(config: Partial<AuditNotifierConfig>): void {
    this.config = { ...this.config, ...config };
    this.ensureLogDirectory();
  }

  /** Гарантировать каталог лога. */
  private ensureLogDirectory(): void {
    if (this.config.filePath) {
      const dir = dirname(this.config.filePath);
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Подпадает ли тип события под нотификацию. */
  shouldNotify(eventType: AuditEventType): boolean {
    if (!this.config.enabled) return false;
    return this.config.eventTypes?.includes(eventType) ?? false;
  }

  /** Дотягивает ли severity до порога. */
  shouldNotifySeverity(severity: AuditSeverity): boolean {
    const minSeverity = this.config.minSeverity ?? "medium";
    const minWeight = SEVERITY_WEIGHTS[minSeverity];
    const eventWeight = SEVERITY_WEIGHTS[severity];
    return eventWeight >= minWeight;
  }

  /** Нотифицировать аудит-событие: файл + webhook, падение — в retry-очередь. */
  async notify(entry: AuditLogEntry): Promise<AuditNotification | null> {
    if (!this.config.enabled) return null;

    const eventType = this.mapEventType(entry.action);
    if (!eventType || !this.shouldNotify(eventType)) return null;

    const severity = this.determineSeverity(entry);
    if (!this.shouldNotifySeverity(severity)) return null;

    const notification: AuditNotification = {
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      message: entry.details || entry.reason || entry.action,
      details: entry.details ? { details: entry.details } : undefined,
      sessionId: entry.sessionId,
    };

    // Пишем в файл
    this.writeToFile(notification);

    // Шлём в webhook, если задан
    if (this.config.webhookUrl) {
      try {
        await this.sendToWebhook(notification);
      } catch (error) {
        defaultOutputBus.log(
          "warn",
          "module:audit",
          `[AuditNotifier] Webhook failed, adding to retry queue: ${error instanceof Error ? error.message : String(error)}`,
          { persist: true },
        );
        this.addToRetryQueue(notification);
      }
    }

    return notification;
  }

  /** Маппинг action записи аудита в тип события нотификации. */
  private mapEventType(action: string): AuditEventType | null {
    const typeMap: Record<string, AuditEventType> = {
      tool_call: "tool_call",
      bash_command: "bash_command",
      file_write: "file_operation",
      file_delete: "file_operation",
      network_request: "network_request",
      security_block: "security_block",
    };
    return typeMap[action] || null;
  }

  /** Severity из записи аудита (по типу action). */
  private determineSeverity(entry: AuditLogEntry): AuditSeverity {
    // Дефолтная severity по типу action
    const typeSeverity: Record<string, AuditSeverity> = {
      security_block: "high",
      bash_command: "high",
      file_delete: "medium",
      file_write: "medium",
      network_request: "medium",
      tool_call: "low",
      session_start: "low",
      session_end: "low",
    };

    return typeSeverity[entry.action] || "low";
  }

  /** Записать нотификацию в файл. */
  private writeToFile(notification: AuditNotification): void {
    if (!this.config.filePath) return;

    try {
      const line = JSON.stringify(notification);
      appendFileSync(this.config.filePath, `${line}\n`, "utf8");
    } catch (error) {
      defaultOutputBus.log(
        "error",
        "module:audit",
        `[AuditNotifier] Failed to write to file: ${error instanceof Error ? error.message : String(error)}`,
        { persist: true },
      );
    }
  }

  /**
   * Отправить нотификацию в webhook. Падение бросает исключение — политику
   * ретраев решает вызывающий (notify() кладёт в очередь, processRetryQueue()
   * считает попытки).
   */
  private async sendToWebhook(notification: AuditNotification): Promise<void> {
    if (!this.config.webhookUrl) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.webhookTimeout);

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notification),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Положить нотификацию в retry-очередь. */
  private addToRetryQueue(notification: AuditNotification): void {
    this.retryQueue.push({ entry: notification, retries: 0 });
    if (!this.isProcessing) {
      this.processRetryQueue();
    }
  }

  /** Разобрать retry-очередь (бэкофф, лимит попыток). */
  private async processRetryQueue(): Promise<void> {
    if (this.retryQueue.length === 0 || this.isProcessing) return;

    this.isProcessing = true;

    try {
      while (this.retryQueue.length > 0) {
        const item = this.retryQueue[0];

        if (item.retries >= (this.config.maxRetries ?? 3)) {
          defaultOutputBus.log(
            "error",
            "module:audit",
            `[AuditNotifier] Max retries exceeded for notification: ${JSON.stringify(item.entry)}`,
            { persist: true },
          );
          this.retryQueue.shift();
          continue;
        }

        try {
          await this.sendToWebhook(item.entry);
          this.retryQueue.shift();
        } catch (error) {
          // sendToWebhook сам в очередь не кладёт — счётчик ретраев реально
          // растёт, и maxRetries достижим.
          item.retries++;
          defaultOutputBus.log(
            "warn",
            "module:audit",
            `[AuditNotifier] Webhook retry ${item.retries} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { persist: true },
          );
          // Экспоненциальный бэкофф перед следующей попыткой того же head-элемента.
          const delay = backoffDelay(item.retries, 1000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /** Прочитать нотификации из файла (последние N). */
  readNotifications(limit: number = 100): AuditNotification[] {
    if (!this.config.filePath || !existsSync(this.config.filePath)) {
      return [];
    }

    try {
      const content = readFileSync(this.config.filePath, "utf8");
      const lines = content.split("\n").filter(Boolean);
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

  /** Очистить нотификации (файл + очередь). */
  clearNotifications(): void {
    if (this.config.filePath) {
      writeFileSync(this.config.filePath, "", "utf8");
    }
    this.retryQueue = [];
  }

  /** Статистика нотификаций: всего, по severity, по типам. */
  getStats(): {
    total: number;
    bySeverity: Record<AuditSeverity, number>;
    byType: Record<AuditEventType, number>;
  } {
    const notifications = this.readNotifications();
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

    for (const n of notifications) {
      bySeverity[n.severity] = (bySeverity[n.severity] || 0) + 1;
      byType[n.eventType] = (byType[n.eventType] || 0) + 1;
    }

    return {
      total: notifications.length,
      bySeverity,
      byType,
    };
  }
}

/** Глобальный инстанс нотификатора аудита. */
export const globalAuditNotifier = new AuditNotifier();

/** Создать нотификатор аудита с кастомным конфигом. */
export function createAuditNotifier(config?: Partial<AuditNotifierConfig>): AuditNotifier {
  return new AuditNotifier(config);
}

// Импорт readFileSync для readNotifications
import { readFileSync } from "fs";
import { globalLogsDir } from "../../config/paths";
