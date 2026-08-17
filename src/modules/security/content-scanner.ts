import type { ContentScanConfig } from "../../config/types";

/**
 * Result of content scanning
 */
export interface ContentScanResult {
  allowed: boolean;
  reason?: string;
  matches?: string[];
}

/**
 * Default dangerous patterns to scan for in file content.
 * NOTE: only genuinely dangerous constructs are listed. Legitimate runtime
 * APIs (process.exit, setTimeout/setInterval, template literals `${}`,
 * backtick strings) are NOT scanned — they are valid JS/TS and blocking
 * them breaks ordinary CLI code (false positives).
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
 * Scan file content for dangerous patterns
 */
export function scanContent(
  content: string,
  filePath: string,
  config?: ContentScanConfig,
): ContentScanResult {
  // If scanning is disabled, allow everything
  if (!config?.enabled) {
    return { allowed: true };
  }

  // Use default patterns if none provided
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
