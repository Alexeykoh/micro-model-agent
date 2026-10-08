/**
 * Push-доставка терминального Job-объекта (спека §8.3) — оптимизация поверх pull.
 *
 * Подпись HMAC-SHA256 по `timestamp + "." + body`; заголовки
 * `X-Mma-Timestamp` (RFC 3339), `X-Mma-Event-Id` (стабилен между ретраями),
 * `X-Mma-Signature`. Ретраи с exponential backoff + jitter; 4xx (кроме 429) —
 * не ретраим (получатель отверг навсегда).
 */
import { createHmac, randomInt } from "node:crypto";

/** HMAC-SHA256 hex по `timestamp + "." + body`. */
export function signature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface WebhookDeliveryOptions {
  url: string;
  secret?: string;
  eventId: string;
  body: string;
  timeoutMs: number;
  maxAttempts?: number;
  /** Тестовый шов: подменяет fetch (без сети). */
  fetchImpl?: typeof fetch;
  /** Тестовый шов: пауза между ретраями (для быстрых тестов). */
  sleep?: (ms: number) => Promise<void>;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  attempts: number;
  lastStatus?: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;

/** Классификация HTTP-статуса: успех / ретраить / сдаваться. */
function statusAction(status: number): "ok" | "retry" | "stop" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 400 && status < 500 && status !== 429) return "stop";
  return "retry";
}

/** Заголовки доставки: свежий timestamp и (опц.) HMAC-подпись. */
function deliveryHeaders(opts: WebhookDeliveryOptions, timestamp: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Mma-Timestamp": timestamp,
    "X-Mma-Event-Id": opts.eventId,
  };
  if (opts.secret) headers["X-Mma-Signature"] = signature(opts.secret, timestamp, opts.body);
  return headers;
}

/** Одна попытка доставки; возвращает действие по статусу (сеть/таймаут → retry). */
async function attemptDelivery(
  opts: WebhookDeliveryOptions,
  fetchImpl: typeof fetch,
): Promise<{ action: "ok" | "retry" | "stop"; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: deliveryHeaders(opts, new Date().toISOString()),
      body: opts.body,
      signal: controller.signal,
    });
    return { action: statusAction(res.status), status: res.status };
  } catch {
    return { action: "retry" };
  } finally {
    clearTimeout(timer);
  }
}

/** Доставляет Job-объект на callbackUrl с подписью и bounded-ретраями. */
export async function deliverWebhook(opts: WebhookDeliveryOptions): Promise<WebhookDeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { action, status } = await attemptDelivery(opts, fetchImpl);
    lastStatus = status;
    if (action === "ok") return { ok: true, attempts: attempt, lastStatus };
    if (action === "stop") return { ok: false, attempts: attempt, lastStatus };
    if (attempt < maxAttempts) {
      const backoff = Math.min(2 ** attempt * 100, 10_000);
      await sleep(backoff + randomInt(0, 100));
    }
  }
  return { ok: false, attempts: maxAttempts, ...(lastStatus !== undefined ? { lastStatus } : {}) };
}
