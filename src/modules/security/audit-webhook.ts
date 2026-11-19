/**
 * Webhook-доставка нотификаций аудита: одна попытка + bounded-очередь ретраев.
 *
 * Вынесено из `audit-notifier.ts` (правило 6, ≤300 строк) и отделено от
 * `AuditNotifier`, который отвечает за «что уведомлять», а не «куда и как
 * доставлять». Адресат проверяется политикой исходящих вызовов (W13): отказ
 * политики не ретраится — адресат не изменится.
 */
import { defaultOutputBus } from "../../output";
import type { Diagnostic } from "../../output/types";
import type { NetworkSecurityConfig } from "../../config/types";
import { backoffDelay } from "../../utils/retry";
import { fetchOutbound, OutboundPolicyError } from "./outbound-policy";

/** Запись очереди ретраев. */
export interface RetryItem<T> {
  entry: T;
  retries: number;
}

/** Отправить нотификацию в webhook; бросает при сетевом/политическом отказе. */
export async function sendWebhook<T>(
  url: string,
  entry: T,
  networkConfig: NetworkSecurityConfig | undefined,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onDiagnostic = (diag: Diagnostic): void => {
    defaultOutputBus.log("warn", diag.source, `${diag.operation}: ${diag.cause}`, {
      diagnostic: true,
      persist: true,
    });
  };

  try {
    const response = await fetchOutbound(
      url,
      "module:audit",
      { networkConfig, operation: "audit.webhook", onDiagnostic },
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`Webhook returned ${response.status}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Очередь ретраев нотификаций аудита (экспоненциальный бэкофф, лимит попыток). */
export class WebhookRetryQueue<T> {
  private queue: RetryItem<T>[] = [];
  private isProcessing = false;

  /** Положить запись в очередь и запустить разбор, если он не идёт. */
  add(entry: T, send: (e: T) => Promise<void>, maxRetries: number): void {
    this.queue.push({ entry, retries: 0 });
    if (!this.isProcessing) void this.process(send, maxRetries);
  }

  /** Очистить очередь (смена конфига, ручной сброс). */
  clear(): void {
    this.queue = [];
  }

  /** Текущая длина очереди (диагностика, тесты). */
  get size(): number {
    return this.queue.length;
  }

  private async process(send: (e: T) => Promise<void>, maxRetries: number): Promise<void> {
    if (this.queue.length === 0 || this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];

        if (item.retries >= maxRetries) {
          defaultOutputBus.log(
            "error",
            "module:audit",
            `[AuditNotifier] Max retries exceeded for notification: ${JSON.stringify(item.entry)}`,
            { persist: true },
          );
          this.queue.shift();
          continue;
        }

        try {
          await send(item.entry);
          this.queue.shift();
        } catch (error) {
          // Отказ политики (W13) не ретраим: адресат не изменится, иначе очередь
          // крутится maxRetries раз впустую.
          if (error instanceof OutboundPolicyError) {
            this.queue.shift();
            continue;
          }
          // `send` сам в очередь не кладёт — счётчик ретраев реально растёт.
          item.retries++;
          defaultOutputBus.log(
            "warn",
            "module:audit",
            `[AuditNotifier] Webhook retry ${item.retries} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { persist: true },
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay(item.retries, 1000)));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}