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
 * Check if a hostname is a private/link-local address (SSRF protection).
 *
 * Handles more than just dotted quads: bare integer / hex / octal encodings
 * (every HTTP client decodes them as a 32-bit IPv4), shorthand quads
 * ("127.1" → 127.0.0.1) and IPv6-mapped IPv4 ("::ffff:7f00:1").
 */
export function isIpPrivate(hostname: string): boolean {
  let h = hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

  if (h.includes(":")) {
    // IPv6-mapped IPv4 (::ffff:127.0.0.1, ::ffff:7f00:1) — decode and fall
    // through to the IPv4 checks below.
    if (h.startsWith("::ffff:")) {
      const mapped = h.slice(7);
      if (!mapped.includes(":")) {
        h = mapped; // dotted quad — fall through
      } else {
        // Hex-colon encoding of the low 32 bits, e.g. "7f00:1".
        const segs = mapped.split(":");
        const hi = parseInt(segs[0], 16);
        const lo = parseInt(segs[1] ?? "", 16);
        if (segs.length !== 2 || Number.isNaN(hi) || Number.isNaN(lo)) return false;
        return isPrivateIpv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255]);
      }
    } else {
      return h === "::1" || /^(fc|fd)/.test(h) || h.startsWith("fe80");
    }
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
