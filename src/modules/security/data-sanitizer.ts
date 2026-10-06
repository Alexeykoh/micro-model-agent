// Вырезание секретов (ключи, токены, пароли) из логов, команд и URL.
/**
 * Целевые паттерны: безошибочно опознаваемые секреты (префиксы, key=value).
 * Не трогают длинные URL/слаги/хеши — их ложная редакция ломала историю.
 */
const TARGETED_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Ключи и токены в формате key=value
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
  // Отдельные ключи (не key=value)
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
  // Bearer-токены в заголовках
  {
    pattern: /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
    replacement: "Bearer [REDACTED]",
  },
];

/**
 * Строгий набор: целевые + высокоэнтропийные строки 30+ символов. Применять
 * только там, где длинный токен почти наверняка секрет; для tool-args/URL
 * использовать `sanitizeLogMessageTargeted` (иначе режутся слаги и хеши).
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  ...TARGETED_PATTERNS,
  {
    pattern: /\b([a-zA-Z0-9_-]{30,})\b/g,
    replacement: "[REDACTED]",
  },
];

function applyPatterns(
  message: string,
  patterns: Array<{ pattern: RegExp; replacement: string }>,
): string {
  let sanitized = message;
  for (const { pattern, replacement } of patterns) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

/** Вычистить секреты из лог-сообщения (только целевые паттерны, без generic). */
export function sanitizeLogMessageTargeted(message: string): string {
  return applyPatterns(message, TARGETED_PATTERNS);
}

/** Вычистить секреты из лог-сообщения (строго: целевые + высокоэнтропийные). */
export function sanitizeLogMessage(message: string): string {
  return applyPatterns(message, SENSITIVE_PATTERNS);
}

/** Вычистить секреты из командной строки. */
export function sanitizeCommand(command: string): string {
  return sanitizeLogMessage(command);
}

/** Вычистить секретные query-параметры из URL; не-URL — целевая редакция. */
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
    return urlObj.toString();
  } catch {
    return sanitizeLogMessageTargeted(url);
  }
}
