/**
 * TLS демона (split W6): PEM-пути из конфига или env, чтение файлов и выбор
 * схемы. Не-loopback без TLS разрешён только при явном
 * `service.tls.terminatedByProxy` (TLS терминирует доверенный ingress).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readEnv } from "../../../config/env";
import type { ServiceConfig } from "../../../config/types";
import { t } from "../../../i18n/index";
import { errMsg } from "../../../utils/error";

/** Итог разрешения TLS: включён ли, опции сервера и схема URL. */
export interface ServiceTls {
  enabled: boolean;
  scheme: "http" | "https";
  options?: { cert: Buffer; key: Buffer };
  /** HTTP на не-loopback допустим: TLS терминирует прокси. */
  terminatedByProxy: boolean;
}

/** Пути cert/key: env (MMA_SERVICE_TLS_*) перекрывает конфиг. */
function paths(service: ServiceConfig): { cert?: string; key?: string } {
  const cert = readEnv("SERVICE_TLS_CERT")?.trim() || service.tls?.cert;
  const key = readEnv("SERVICE_TLS_KEY")?.trim() || service.tls?.key;
  return { ...(cert ? { cert } : {}), ...(key ? { key } : {}) };
}

/**
 * Читает PEM-файлы и решает, поднимать ли HTTPS. `cert` без `key` (или
 * наоборот) — ошибка конфига, а не тихий HTTP.
 */
export function resolveServiceTls(service: ServiceConfig): ServiceTls {
  const proxyEnv = readEnv("SERVICE_TLS_PROXY");
  const terminatedByProxy =
    proxyEnv !== undefined
      ? proxyEnv === "1" || proxyEnv.toLowerCase() === "true"
      : service.tls?.terminatedByProxy === true;
  const { cert, key } = paths(service);
  if (!cert && !key) return { enabled: false, scheme: "http", terminatedByProxy };
  if (!cert || !key) {
    throw new Error(t("service.tls_key_pair_required"));
  }
  try {
    return {
      enabled: true,
      scheme: "https",
      options: { cert: readFileSync(resolve(cert)), key: readFileSync(resolve(key)) },
      terminatedByProxy,
    };
  } catch (err) {
    throw new Error(t("service.tls_read_failed", { error: errMsg(err) }));
  }
}

/** Не-loopback обязан иметь токен и TLS (в приложении или за прокси). */
export function tlsPolicyError(tls: ServiceTls): string | undefined {
  if (tls.enabled || tls.terminatedByProxy) return undefined;
  return t("service.missing_tls_nonloopback");
}
