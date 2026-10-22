/**
 * Конфиг Agent Service API v1 (`service.*`). Вынесено из `types.ts` по правилу 6:
 * секция растёт вместе с поверхностью сервиса и не должна тянуть общий файл.
 */

/** Agent Service API v1: HTTP-сервис (`mma serve`) поверх того же ядра. */
export interface ServiceConfig {
  /** Порт HTTP-сервиса. CLI `--port` перекрывает. */
  port: number;
  /** Адрес привязки. Не-loopback без токена запрещён. */
  host: string;
  /** Bearer-токен внутреннего вызова (control plane ↔ runtime). Опц. для loopback. */
  token?: string;
  /**
   * Тенант, которому принадлежит процесс (silo: 1 процесс = 1 тенант). Он
   * авторитетен для authz: `X-Mma-Tenant` лишь сверяется с ним, а не задаёт
   * тенанта. Не задан — процесс обслуживает единый безымянный тенант.
   */
  tenant?: string;
  /** Срок хранения терминальных результатов задач (дни). */
  resultRetentionDays: number;
  /** TTL Idempotency-Key (часы). */
  idempotencyTtlHours: number;
  /** Верхняя граница синхронного ожидания `wait:true` (мс). */
  syncWaitMs: number;
  /** Кап FIFO-очереди задач на сессию. */
  maxQueueLength: number;
  /** Таймаут доставки webhook-колбэка (мс). */
  callbackTimeoutMs: number;
  /** Секрет HMAC-подписи webhook-колбэков. Не задан — подпись не выставляется. */
  webhookSecret?: string;
  /**
   * Разрешить `http`-callback для loopback (`127.0.0.1`/`localhost`/`::1`).
   * По умолчанию только `https`: тело webhook'а несёт результат хода.
   */
  webhookAllowHttp?: boolean;
}
