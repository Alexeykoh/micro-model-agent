// Санитизация shell-команд для логов (вырезание секретов) — вынесено из
// `command-validator.ts` (правило ≤300). Паттерны те же, что в
// `sanitizeLogMessage`, — для консистентности.

/**
 * Санитизация команды для логов (вырезание секретов).
 * Те же паттерны, что в sanitizeLogMessage, — для консистентности.
 */
export function sanitizeCommandForLog(command: string): string {
  // Паттерны из data-sanitizer — для консистентности
  const patterns = [
    /(api[_-]?key|apikey|api_key)\s*[=:\s]\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
    /(token|access[_-]?token|auth[_-]?token)\s*[=:\s]\s*["']?([a-zA-Z0-9_-]{10,})["']?/gi,
    /(password|passwd|pwd|pass)\s*[=:\s]\s*["']?([^\s"'&]+)["']?/gi,
    /(secret|private[_-]?key|secret[_-]?key)\s*[=:\s]\s*["']?([^\s"'&]+)["']?/gi,
    /\bsk-[a-zA-Z0-9_-]{20,}\b/gi,
    /\bctx7sk-[a-zA-Z0-9_-]{10,}\b/gi,
    /\bghp_[a-zA-Z0-9]{30,}\b/gi,
    /\bgithub_pat_[a-zA-Z0-9]{20,}\b/gi,
    /\bAKIA[0-9A-Z]{15,}\b/gi,
    /Bearer\s+[a-zA-Z0-9_-]{20,}/gi,
    /\b([a-zA-Z0-9_-]{30,})\b/g,
  ];

  let sanitized = command;
  for (const pattern of patterns) {
    // Замена целиком по каждому паттерну: замена с учётом групп переизлучила бы
    // сам секрет для паттернов, где группа И ЕСТЬ значение.
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}
