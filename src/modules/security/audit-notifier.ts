// Нотификации о security-событиях: файл + webhook с ретраями и очередью.
import { join } from "path";
import type { AuditLogEntry } from "./audit-log";
import { defaultOutputBus } from "../../output";
import { sendWebhook, WebhookRetryQueue } from "./audit-webhook";
import { OutboundPolicyError } from "./outbound-policy";
import { AuditNotificationStore } from "./audit-notifier-store";
import { globalLogsDir } from "../../config/paths";
import type { EgressGuard } from "./data-policy/types";
import type { NetworkSecurityConfig } from "../../config/types";

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
  /** Сетевая политика для webhook-адресата (W13, D5); без неё — базовые правила. */
  networkConfig?: NetworkSecurityConfig;
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

/** DLP-проекция webhook-payload (E2); ставит config-phase из dataPolicy. */
let egressGuard: EgressGuard<unknown, unknown> | undefined;

/** Зарегистрировать guard для webhook-нотификаций (undefined — без редакции). */
export function setAuditEgressGuard(guard: EgressGuard<unknown, unknown> | undefined): void {
  egressGuard = guard;
}

/** Нотификатор security-событий: файл + webhook с ретраями. */
export class AuditNotifier {
  private config: AuditNotifierConfig;
  /** Очередь ретраев вынесена в `audit-webhook.ts` (правило 6). */
  private retries = new WebhookRetryQueue<AuditNotification>();
  private store: AuditNotificationStore;

  constructor(config?: Partial<AuditNotifierConfig>) {
    this.config = { ...DEFAULT_AUDIT_NOTIFIER_CONFIG, ...config };
    this.store = new AuditNotificationStore(this.config.filePath);
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
    this.store = new AuditNotificationStore(this.config.filePath);
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
    this.store.write(notification);

    // Шлём в webhook, если задан
    if (this.config.webhookUrl) {
      try {
        await this.sendToWebhook(notification);
      } catch (error) {
        // Отказ политики исходящих вызовов (W13): адресат не изменится, ретраи
        // только размножают попытки во внутреннюю сеть.
        if (error instanceof OutboundPolicyError) {
          defaultOutputBus.log(
            "warn",
            "module:audit",
            `[AuditNotifier] Webhook blocked by outbound policy: ${error.reason}`,
            { persist: true, diagnostic: true },
          );
          return notification;
        }
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

  /**
   * Отправить нотификацию в webhook. Падение бросает исключение — политику
   * ретраев решает вызывающий (notify() кладёт в очередь ретраев).
   */
  private sendToWebhook(notification: AuditNotification): Promise<void> {
    const url = this.config.webhookUrl;
    if (!url) return Promise.resolve();
    // Внешний адресат: payload проходит ту же DLP-редакцию, что API-ответы.
    const payload = egressGuard ? egressGuard.filterClient(notification) : notification;
    return sendWebhook(url, payload, this.config.networkConfig, this.config.webhookTimeout ?? 5000);
  }

  /** Положить нотификацию в retry-очередь. */
  private addToRetryQueue(notification: AuditNotification): void {
    this.retries.add(notification, (e) => this.sendToWebhook(e), this.config.maxRetries ?? 3);
  }

  /** Прочитать нотификации из файла (последние N). */
  readNotifications(limit: number = 100): AuditNotification[] {
    return this.store.read(limit);
  }

  /** Очистить нотификации (файл + очередь). */
  clearNotifications(): void {
    this.store.clear();
    this.retries.clear();
  }

  /** Статистика нотификаций: всего, по severity, по типам. */
  getStats(): ReturnType<AuditNotificationStore["stats"]> {
    return this.store.stats();
  }
}

/** Глобальный инстанс нотификатора аудита. */
export const globalAuditNotifier = new AuditNotifier();

/** Создать нотификатор аудита с кастомным конфигом. */
export function createAuditNotifier(config?: Partial<AuditNotifierConfig>): AuditNotifier {
  return new AuditNotifier(config);
}


