import type { NetworkSecurityConfig } from "../../config/types";
import { sanitizeLogMessage } from "./data-sanitizer";

/**
 * Result of URL validation
 */
export interface NetworkValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Parse a numeric IP component honoring decimal, hex (0x…) and octal (0…)
 * notations. Returns null when the token is not purely numeric.
 */
function parseIpNumber(s: string): number | null {
  if (/^0x[0-9a-f]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s.slice(1), 8);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

/** Check whether four decoded octets form a private/reserved IPv4 address. */
function isPrivateIpv4(o: number[]): boolean {
  const [a, b = 0, c = 0, d = 0] = o;
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
 * Rewrite a trailing dotted-quad (IPv4-mapped literal, e.g. `::ffff:127.0.0.1`)
 * as two hex groups so the generic IPv6 expansion can parse it.
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

/** Expand an IPv6 literal (no zone) into 8 groups; null when malformed. */
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
 * Check if a hostname is a private/link-local address (SSRF protection).
 *
 * Handles more than just dotted quads: bare integer / hex / octal encodings
 * (every HTTP client decodes them as a 32-bit IPv4), shorthand quads
 * ("127.1" → 127.0.0.1) and IPv6 — loopback/unspecified/link-local/
 * unique-local and IPv4-mapped, in any expansion form (the old string prefix
 * checks missed `0:0:0:0:0:0:0:1` and `::ffff:0:7f00:1`).
 */
export function isIpPrivate(hostname: string): boolean {
  let h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

  if (h.includes(":")) {
    const g = expandIpv6(h);
    if (!g) return false;
    // IPv4-mapped/translated (::ffff:a.b.c.d) in any zero-padded form: the high
    // 96 bits are zeros/ffff and the low 32 bits are a private IPv4.
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

  // Bare integer/hex/octal: interpreted as one 32-bit IPv4 word.
  if (!h.includes(".")) {
    const n = parseIpNumber(h);
    if (n === null) return false; // a domain name, not an IP
    if (n < 0 || n > 0xffffffff) return false;
    return isPrivateIpv4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  // Dotted form: decode each part (hex/octal aware); shorthand like
  // "127.1" pads the missing groups before the last.
  const parts = h.split(".");
  const nums: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = parseIpNumber(parts[i]);
    if (n === null || n > 255) return false; // domain or malformed — not our concern
    nums.push(n);
  }
  while (nums.length < 4) nums.splice(nums.length - 1, 0, 0);
  if (nums.length !== 4) return false;
  return isPrivateIpv4(nums);
}

/**
 * Check if a URL is allowed based on security configuration
 */
export function isUrlAllowed(
  url: string,
  securityConfig?: NetworkSecurityConfig,
): NetworkValidationResult {
  // If security is disabled, allow everything
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

    // Check denied domains first
    if (securityConfig.deniedDomains?.length) {
      for (const deniedDomain of securityConfig.deniedDomains) {
        const denied = deniedDomain.toLowerCase();
        if (domain === denied || domain.endsWith(`.${denied}`)) {
          return { allowed: false, reason: `Domain "${domain}" is denied` };
        }
      }
    }

    // Check allowed domains (if non-empty, only these are allowed)
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

/** Max redirect hops followed (and re-validated) by {@link fetchValidated}. */
export const MAX_REDIRECTS = 5;

/** Thrown by {@link fetchValidated} when a hop is disallowed by the policy. */
export class BlockedRedirectError extends Error {
  constructor(public readonly reason: string) {
    super(`redirect blocked: ${reason}`);
    this.name = "BlockedRedirectError";
  }
}

export interface ValidatedFetchResult {
  response: Response;
  finalUrl: string;
}

/**
 * Fetch a URL following redirects MANUALLY, re-validating every hop against the
 * SSRF/domain policy. Plain `fetch` with the default `redirect: "follow"` only
 * validates the initial URL, so a public URL that 302s to `127.0.0.1` or the
 * cloud metadata endpoint reaches the internal service. Throws
 * {@link BlockedRedirectError} when a hop is disallowed or the cap is exceeded.
 */
export async function fetchValidated(
  url: string,
  securityConfig: NetworkSecurityConfig | undefined,
  init: RequestInit = {},
): Promise<ValidatedFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = isUrlAllowed(current, securityConfig);
    if (!check.allowed) throw new BlockedRedirectError(check.reason || "URL not allowed");

    const response = await fetch(current, { ...init, redirect: "manual" });
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

/**
 * Sanitize URL for logging (remove sensitive information)
 */
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

    // Also sanitize credentials in URL (user:pass@host)
    if (urlObj.username || urlObj.password) {
      result = result.replace(/:\/\/[^:]+:[^@]+@/, "://[REDACTED]:[REDACTED]@");
    }

    // Decode URL-encoded [REDACTED] back to plain text
    result = decodeURIComponent(result);

    return result;
  } catch {
    return sanitizeLogMessage(url);
  }
}
