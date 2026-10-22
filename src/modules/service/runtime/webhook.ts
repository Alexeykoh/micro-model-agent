/**
 * Push-доставка терминального Job-объекта (спека §8.3) — оптимизация поверх pull.
 *
 * Подпись HMAC-SHA256 по `timestamp + "." + body`; заголовки
 * `X-Mma-Timestamp` (RFC 3339, **один на доставку**, не на попытку),
 * `X-Mma-Event-Id` (стабилен между ретраями), `X-Mma-Delivery` (номер попытки),
 * `X-Mma-Signature`. Ретраи с exponential backoff + jitter и общим дедлайном;
 * 3xx/4xx (кроме 429) — терминальный отказ (redirect'ы не преследуются).
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { NetworkSecurityConfig } from "../../../config/types";
import type { Diagnostic } from "../../../output/types";
import { checkCallbackUrl } from "./callback-url";

/** HMAC-SHA256 hex по `timestamp + "." + body`. */
export function signature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Окно replay для проверки подписи на стороне получателя (5 минут). */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export interface VerifySignatureInput {
  secret: string;
  /** Сырое тело запроса (то же, что подписывалось). */
  body: string;
  /** Значение `X-Mma-Signature`. */
  signature: string;
  /** Значение `X-Mma-Timestamp` (RFC 3339). */
  timestamp: string;
  windowMs?: number;
  /** Тестовый шов часов. */
  now?: number;
}

/**
 * Контрпара к `signature()` для получателя: сравнение за константное время и
 * окно replay. Старые/будущие подписи и подделки → `false`.
 */
export function verifySignature(input: VerifySignatureInput): boolean {
  const ts = Date.parse(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const windowMs = input.windowMs ?? SIGNATURE_WINDOW_MS;
  if (Math.abs((input.now ?? Date.now()) - ts) > windowMs) return false;
  const expected = Buffer.from(signature(input.secret, input.timestamp, input.body));
  const actual = Buffer.from(input.signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
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
  /** Тестовый шов часов (дедлайн/подпись). */
  now?: () => number;
  /** Доменная политика и флаг `allowPrivateOutbound` для проверки адресата (D5). */
  networkConfig?: NetworkSecurityConfig;
  /** `service.webhookAllowHttp`: http разрешён только для loopback. */
  allowHttp?: boolean;
  /**
   * DLP-проекция тела перед отправкой (E2): webhook — внешний адресат, значит
   * payload проходит ту же редакцию, что API-ответы. Структурный контракт,
   * чтобы service не зависел от security-типов.
   */
  egress?: { filterClient<P>(payload: P): P };
  /** Куда записать отказ политики (INV-14). */
  onDiagnostic?: (diag: Diagnostic) => void;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  attempts: number;
  lastStatus?: number;
  /** Адресат отклонён политикой исходящих вызовов; попыток не было. */
  blocked?: boolean;
}

const DEFAULT_MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Общий дедлайн доставки: ретраи не могут длиться вечно из-за таймаутов. */
export const WEBHOOK_DEADLINE_MS = 120_000;

/**
 * Классификация HTTP-статуса: успех / ретраить / сдаваться.
 * 3xx — терминальный отказ: следовать redirect'у нельзя (адресат после
 * редиректа не проходил SSRF-проверку), а `fetch` вызывается с `redirect:"manual"`.
 */
function statusAction(status: number): "ok" | "retry" | "stop" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 500 && status !== 429) return "stop";
  return "retry";
}

/** Заголовки доставки: timestamp один на доставку, подпись — по её телу. */
function deliveryHeaders(
  opts: WebhookDeliveryOptions,
  timestamp: string,
  attempt: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Mma-Timestamp": timestamp,
    "X-Mma-Event-Id": opts.eventId,
    "X-Mma-Delivery": String(attempt),
  };
  if (opts.secret) headers["X-Mma-Signature"] = signature(opts.secret, timestamp, opts.body);
  return headers;
}

/** Одна попытка доставки; возвращает действие по статусу (сеть/таймаут → retry). */
async function attemptDelivery(
  opts: WebhookDeliveryOptions,
  fetchImpl: typeof fetch,
  timestamp: string,
  attempt: number,
): Promise<{ action: "ok" | "retry" | "stop"; status?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: deliveryHeaders(opts, timestamp, attempt),
      body: opts.body,
      // Redirect не преследуем: конечный адрес не проходил проверку политики.
      redirect: "manual",
      signal: controller.signal,
    });
    return { action: statusAction(res.status), status: res.status };
  } catch {
    return { action: "retry" };
  } finally {
    clearTimeout(timer);
  }
}

/** Пауза перед следующей попыткой: exponential backoff с потолком и jitter. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS) + randomInt(0, 250);
}

/** Доставляет Job-объект на callbackUrl с подписью и bounded-ретраями. */
export async function deliverWebhook(opts: WebhookDeliveryOptions): Promise<WebhookDeliveryResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const startedAt = now();
  let lastStatus: number | undefined;

  // DLP до политики исходящих вызовов и до подписи: тело и HMAC — по одному
  // (отредактированному) payload'у, иначе получатель не проверит подпись.
  const prepared = applyEgress(opts);

  // Политика исходящих вызовов (W13) + требование https (W10.4): адресат
  // приходит из тела /v1/tasks, то есть из недоверенного источника. Отказ не
  // ретраится — адресат не изменится.
  const check = checkCallbackUrl(prepared.url, {
    ...(prepared.networkConfig ? { networkConfig: prepared.networkConfig } : {}),
    allowHttp: prepared.allowHttp ?? false,
    operation: "service.callback",
    ...(prepared.onDiagnostic ? { onDiagnostic: prepared.onDiagnostic } : {}),
  });
  if (!check.allowed) {
    return { ok: false, attempts: 0, blocked: true };
  }

  const timestamp = new Date(now()).toISOString();
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const { action, status } = await attemptDelivery(prepared, fetchImpl, timestamp, attempt);
    lastStatus = status;
    if (action === "ok") return { ok: true, attempts, lastStatus };
    if (action === "stop") return { ok: false, attempts, lastStatus };
    if (attempt < maxAttempts) {
      const delay = backoffMs(attempt);
      if (now() - startedAt + delay > WEBHOOK_DEADLINE_MS) break;
      await sleep(delay);
    }
  }
  return { ok: false, attempts, ...(lastStatus !== undefined ? { lastStatus } : {}) };
}

/** Применить egress-проекцию к JSON-телу; не-JSON/ошибка — оставить как есть. */
function applyEgress(opts: WebhookDeliveryOptions): WebhookDeliveryOptions {
  if (!opts.egress) return opts;
  try {
    const parsed = JSON.parse(opts.body) as unknown;
    return { ...opts, body: JSON.stringify(opts.egress.filterClient(parsed)) };
  } catch {
    return opts;
  }
}
