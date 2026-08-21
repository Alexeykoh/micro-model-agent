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
 * Check if a hostname is a private/link-local address (SSRF protection).
 */
export function isIpPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      h,
    ) ||
    h === "::1" ||
    /^(fc|fd)/.test(h) ||
    (h.includes(":") && h.startsWith("fe80"))
  );
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
