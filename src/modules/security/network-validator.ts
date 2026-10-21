// Валидация URL: SSRF-защита, allow/deny-домены, fetch с ручными редиректами.
import type { NetworkSecurityConfig } from "../../config/types";
import { sanitizeLogMessage } from "./data-sanitizer";

/** Итог проверки URL: разрешено/запрет с причиной. */
export interface NetworkValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Разобрать числовой компонент IP с учётом decimal, hex (0x…) и octal (0…).
 * Не числовой токен — null.
 */
function parseIpNumber(s: string): number | null {
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s.slice(1), 8);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

/** Образуют ли четыре октета приватный/резервный IPv4. */
function isPrivateIpv4(o: number[]): boolean {
  const [a, b = 0, _c = 0, _d = 0] = o;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * Переписать хвостовой dotted-quad (IPv4-mapped литерал, напр. `::ffff:127.0.0.1`)
 * двумя hex-группами, чтобы общий парсер IPv6 его разобрал.
 */
function normalizeIpv4Tail(input: string): string | null {
  const idx = input.lastIndexOf(":");
  const tail = idx >= 0 ? input.slice(idx + 1) : input;
  if (!tail.includes(".")) return input;
  const oct = tail.split(".").map((d) => parseInt(d, 10));
  if (oct.length !== 4 || oct.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  const hi = (((oct[0] << 8) | oct[1]) & 0xffff).toString(16);
  const lo = (((oct[2] << 8) | oct[3]) & 0xffff).toString(16);
  return `${idx >= 0 ? input.slice(0, idx + 1) : ""}${hi}:${lo}`;
}

/** Развернуть IPv6-литерал (без зоны) в 8 групп; кривой — null. */
function expandIpv6(input: string): number[] | null {
  const normalized = normalizeIpv4Tail(input.split("%")[0]);
  if (normalized === null) return null;
  const h = normalized;
  const parse = (s: string): number[] =>
    s ? s.split(":").filter((x) => x !== "").map((x) => parseInt(x, 16)) : [];
  const [head, tail] = h.split("::");
  let groups: number[];
  if (tail !== undefined) {
    const a = parse(head);
    const b = parse(tail);
    const zeros = 8 - a.length - b.length;
    if (zeros < 0) return null;
    groups = [...a, ...new Array<number>(zeros).fill(0), ...b];
  } else {
    groups = parse(h);
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

/**
 * Приватный/link-local адрес в hostname (SSRF-защита) или нет.
 * Покрывает не только dotted-quad: голые int/hex/octal-кодировки
 * (любой HTTP-клиент декодит их как 32-битный IPv4), короткие квады
 * ("127.1" → 127.0.0.1) и IPv6 — loopback/unspecified/link-local/
 * unique-local и IPv4-mapped в любой форме раскрытия (старые строковые
 * префиксы пропускали `0:0:0:0:0:0:0:1` и `::ffff:0:7f00:1`).
 */
export function isIpPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

  if (h.includes(":")) {
    const g = expandIpv6(h);
    if (!g) return false;
    // IPv4-mapped/translated (::ffff:a.b.c.d) в любой форме с нулями: старшие
    // 96 бит — нули/ffff, младшие 32 — приватный IPv4.
    const high = g.slice(0, 6);
    if (
      high.some((n) => n === 0xffff) &&
      high.every((n) => n === 0 || n === 0xffff) &&
      isPrivateIpv4([(g[6] >> 8) & 255, g[6] & 255, (g[7] >> 8) & 255, g[7] & 255])
    ) {
      return true;
    }
    if (g.slice(0, 7).every((n) => n === 0) && g[7] <= 1) return true; // :: and ::1
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    return false;
  }

  if (h === "localhost") return true;

  // Голый int/hex/octal: интерпретируется как одно 32-битное слово IPv4.
  if (!h.includes(".")) {
    const n = parseIpNumber(h);
    if (n === null) return false; // доменное имя, не IP
    if (n < 0 || n > 0xffffffff) return false;
    return isPrivateIpv4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  // Точечная форма: декодим каждую часть (hex/octal-aware); короткие вроде
  // "127.1" добивают пропущенные группы нулями перед последней.
  const parts = h.split(".");
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = parseIpNumber(parts[i]);
    if (n === null || n > 255) return false; // домен или мусор — не наша забота
    nums.push(n);
  }
  while (nums.length < 4) nums.splice(nums.length - 1, 0, 0);
  if (nums.length !== 4) return false;
  return isPrivateIpv4(nums);
}

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
): Promise<ValidatedFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = isUrlAllowed(current, securityConfig);
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
