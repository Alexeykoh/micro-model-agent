/**
 * Patterns for sensitive data that should be redacted from logs
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys and tokens in key=value format
  {
    pattern: /(api[_-]?key|apikey|api_key)\s*[=:\s]\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
    replacement: "$1=[REDACTED]",
  },
  {
    pattern: /(token|access[_-]?token|auth[_-]?token)\s*[=:\s]\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
    replacement: "$1=[REDACTED]",
  },
  {
    pattern: /(password|passwd|pwd|pass)\s*[=:\s]\s*["']?([^\s"'&]+)["']?/gi,
    replacement: "$1=[REDACTED]",
  },
  {
    pattern: /(secret|private[_-]?key|secret[_-]?key)\s*[=:\s]\s*["']?([^\s"'&]+)["']?/gi,
    replacement: "$1=[REDACTED]",
  },
  // Standalone API keys (not in key=value format)
  {
    pattern: /\bsk-[a-zA-Z0-9_-]{20,}\b/gi,
    replacement: "sk-[REDACTED]",
  },
  {
    pattern: /\bctx7sk-[a-zA-Z0-9_-]{10,}\b/gi,
    replacement: "ctx7sk-[REDACTED]",
  },
  {
    pattern: /\bghp_[a-zA-Z0-9]{30,}\b/gi,
    replacement: "ghp_[REDACTED]",
  },
  {
    pattern: /\bgithub_pat_[a-zA-Z0-9]{20,}\b/gi,
    replacement: "github_pat_[REDACTED]",
  },
  {
    pattern: /\bAKIA[0-9A-Z]{15,}\b/gi,
    replacement: "AKIA[REDACTED]",
  },
  // Bearer tokens in headers
  {
    pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
    replacement: "Bearer [REDACTED]",
  },
  // Generic high-entropy strings that look like secrets (30+ chars, mixed case and numbers)
  {
    pattern: /\b([a-zA-Z0-9_-]{30,})\b/g,
    replacement: "[REDACTED]",
  },
];

/**
 * Sanitize a log message by removing sensitive information
 */
export function sanitizeLogMessage(message: string): string {
  let sanitized = message;

  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  return sanitized;
}

/**
 * Sanitize a command string by removing sensitive information
 */
export function sanitizeCommand(command: string): string {
  return sanitizeLogMessage(command);
}

/**
 * Sanitize a URL by removing sensitive query parameters
 */
export function sanitizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const sensitiveKeys = [
      "api_key",
      "token",
      "password",
      "secret",
      "access_token",
      "auth",
      "key",
    ];

    const sanitizedParams = new URLSearchParams(urlObj.search);
    for (const key of sensitiveKeys) {
      if (sanitizedParams.has(key)) {
        sanitizedParams.set(key, "[REDACTED]");
      }
    }

    urlObj.search = sanitizedParams.toString();
    return urlObj.toString();
  } catch {
    return sanitizeLogMessage(url);
  }
}
