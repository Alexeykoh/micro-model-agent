// Сканер содержимого файлов на опасные паттерны перед записью.
import type { ContentScanConfig } from "../../config/types";

/** Итог сканирования: разрешено/запрет с причиной и совпадениями. */
export interface ContentScanResult {
  allowed: boolean;
  reason?: string;
  matches?: string[];
}

/**
 * Дефолтные опасные паттерны.
 * В списке только реально опасные конструкции. Легитимные рантайм-API
 * (process.exit, setTimeout/setInterval, шаблонные литералы `${}`, бэктики)
 * НЕ сканируются — это валидный JS/TS, их блок ломает обычный CLI-код.
 */
const DEFAULT_DANGEROUS_PATTERNS: RegExp[] = [
  /eval\(/gi,
  /new Function\(/gi,
  /child_process\.exec\(/gi,
  /child_process\.spawn\(/gi,
  /require\('child_process'\)/gi,
  /require\('http'\).createServer/gi,
  /require\('net'\).createServer/gi,
  /require\('fs'\).writeFileSync/gi,
  /require\('fs'\).unlinkSync/gi,
  /while\(true\)/gi,
  /for\(;;\)/gi,
  /rm -rf/gi,
  /dd if=/gi,
  /chmod 777/gi,
  /wget.*\|.*sh/gi,
  /curl.*\|.*sh/gi,
];

/**
 * Проверить содержимое файла на опасные паттерны.
 * Выключенный скан и пустой список паттернов разрешают всё.
 */
export function scanContent(
  content: string,
  filePath: string,
  config?: ContentScanConfig,
): ContentScanResult {
  // Выключенный скан разрешает всё
  if (!config?.enabled) {
    return { allowed: true };
  }

  // Без своих паттернов — дефолтные
  const patterns = config.dangerousPatterns?.length
    ? config.dangerousPatterns
    : DEFAULT_DANGEROUS_PATTERNS;
  const matches: string[] = [];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      matches.push(...match);
    }
  }

  if (matches.length > 0) {
    return {
      allowed: false,
      reason: `Content contains dangerous patterns in ${filePath}: ${matches.slice(0, 3).join(", ")}`,
      matches,
    };
  }

  return { allowed: true };
}
