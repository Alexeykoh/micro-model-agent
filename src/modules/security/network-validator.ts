// Валидация URL: SSRF-защита, allow/deny-домены, fetch с ручными редиректами.
import type { NetworkSecurityConfig } from "../../config/types";
import { sanitizeLogMessage } from "./data-sanitizer";
import { isIpLiteral, isIpPrivate } from "./ip-guard";
import { resolvesToPrivate, type DnsResolver } from "./dns-guard";

/** Итог проверки URL: разрешено/запрет с причиной. */
export interface NetworkValidationResult {
  allowed: boolean;
  reason?: string;
}

/** Проверка приватных адресов живёт в `ip-guard.ts` (её же использует DNS-гард). */
export { isIpPrivate } from "./ip-guard";

/** Разрешён ли URL по конфигу (схема, SSRF, deny/allow-домены). */
export function isUrlAllowed(
  url: string,
  securityConfig?: NetworkSecurityConfig,
): NetworkValidationResult {
  // Выключенная защита разрешает всё
  if (!securityConfig?.enabled) {
    return { allowed: true };
  }

  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();

    const scheme = urlObj.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") {
      return { allowed: false, reason: `Scheme "${scheme}" is not allowed` };
    }
    if (isIpPrivate(domain)) {
      return { allowed: false, reason: `Private address "${domain}" is blocked (SSRF)` };
    }

    // Сначала denied-домены
    if (securityConfig.deniedDomains?.length) {
      for (const deniedDomain of securityConfig.deniedDomains) {
        const denied = deniedDomain.toLowerCase();
        if (domain === denied || domain.endsWith(`.${denied}`)) {
          return { allowed: false, reason: `Domain "${domain}" is denied` };
        }
      }
    }

    // Затем allowed-домены (непустой — разрешены только перечисленные)
    if (securityConfig.allowedDomains?.length) {
      let isAllowed = false;
      for (const allowedDomain of securityConfig.allowedDomains) {
        const allowed = allowedDomain.toLowerCase();
        if (domain === allowed || domain.endsWith(`.${allowed}`)) {
          isAllowed = true;
          break;
        }
      }
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Domain "${domain}" is not in the allowed list`,
        };
      }
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: `Invalid URL: ${url}` };
  }
}

/** Максимум редиректов, которые проходит (и ревалидирует) {@link fetchValidated}. */
export const MAX_REDIRECTS = 5;

/**
 * Проверка URL с учётом DNS (аудит §2.6): имя хоста может резолвиться в
 * приватный адрес, и «публичный» URL дотягивается до внутреннего сервиса.
 *
 * Fail-open при ошибке резолва (офлайн-режим не должен ломаться), fail-closed
 * при явном приватном адресе.
 */
export async function isUrlAllowedAsync(
  url: string,
  securityConfig?: NetworkSecurityConfig,
  resolver?: DnsResolver,
): Promise<NetworkValidationResult> {
  const sync = isUrlAllowed(url, securityConfig);
  if (!sync.allowed) return sync;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return sync;
  }
  if (isIpLiteral(host) || host.toLowerCase() === "localhost") return sync;
  if (await resolvesToPrivate(host, resolver)) {
    return {
      allowed: false,
      reason: `Host "${host}" resolves to a private address (SSRF)`,
    };
  }
  return sync;
}

/** Бросает {@link fetchValidated}, когда хоп запрещён политикой. */
export class BlockedRedirectError extends Error {
  constructor(public readonly reason: string) {
    super(`redirect blocked: ${reason}`);
    this.name = "BlockedRedirectError";
  }
}

/** Итог валидированного fetch: ответ и финальный URL. */
export interface ValidatedFetchResult {
  response: Response;
  finalUrl: string;
}

/**
 * Fetch URL с РУЧНЫМИ редиректами, ревалидируя каждый хоп против SSRF/доменной
 * политики. Обычный `fetch` с `redirect: "follow"` проверяет только стартовый
 * URL, и публичный URL с 302 на `127.0.0.1` или metadata-эндпоинт облака
 * дотягивается до внутреннего сервиса. Запрещённый хоп или превышение лимита —
 * {@link BlockedRedirectError}.
 */
export async function fetchValidated(
  url: string,
  securityConfig: NetworkSecurityConfig | undefined,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  resolver?: DnsResolver,
): Promise<ValidatedFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // DNS-учитывающая проверка: хост может резолвиться в приватный адрес.
    const check = await isUrlAllowedAsync(current, securityConfig, resolver);
    if (!check.allowed) throw new BlockedRedirectError(check.reason || "URL not allowed");

    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { response, finalUrl: current };
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new BlockedRedirectError("invalid redirect location");
      }
      continue;
    }
    return { response, finalUrl: current };
  }
  throw new BlockedRedirectError("too many redirects");
}

/** Санитизация URL для логов (вырезание секретов). */
export function sanitizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const sensitiveKeys = ["api_key", "token", "password", "secret", "access_token", "auth", "key"];

    const sanitizedParams = new URLSearchParams(urlObj.search);
    for (const key of sensitiveKeys) {
      if (sanitizedParams.has(key)) {
        sanitizedParams.set(key, "[REDACTED]");
      }
    }

    urlObj.search = sanitizedParams.toString();
    let result = urlObj.toString();

    // Плюс креды в URL (user:pass@host)
    if (urlObj.username || urlObj.password) {
      result = result.replace(/:\/\/[^:]+:[^@]+@/, "://[REDACTED]:[REDACTED]@");
    }

    // Декодим URL-encoded [REDACTED] обратно в plain text
    result = decodeURIComponent(result);

    return result;
  } catch {
    return sanitizeLogMessage(url);
  }
}
