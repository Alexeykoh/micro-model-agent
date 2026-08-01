import { resolve, normalize } from "path";
import type { PathSecurityConfig } from "../../config/types";
import type { ToolScope } from "../../tools/types";

/**
 * Result of path validation
 */
export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a path is within the allowed scope
 * This combines global security settings with per-tool scope
 */
export function isPathInScope(
  baseDir: string,
  targetPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): PathValidationResult {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(targetPath));

  // First, check that path is within baseDir
  if (!targetResolved.startsWith(baseResolved)) {
    return { allowed: false, reason: "Path is outside the base working directory" };
  }

  // Check global denied patterns
  if (securityConfig?.denied?.length) {
    for (const pattern of securityConfig.denied) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        return { allowed: false, reason: `Path matches denied pattern: ${pattern}` };
      }
    }
  }

  // Check global allowed patterns (if non-empty, only these are allowed)
  if (securityConfig?.allowed?.length) {
    let isAllowed = false;
    for (const pattern of securityConfig.allowed) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      return { allowed: false, reason: "Path does not match any allowed pattern" };
    }
  }

  // Check tool-specific scope (for subagents)
  if (!scope) {
    return { allowed: true };
  }

  const isRead = scope.read_only_files.some((f: string) =>
    targetResolved.startsWith(resolve(baseDir, f)),
  );
  const isWrite = scope.allowed_files.some((f: string) =>
    targetResolved.startsWith(resolve(baseDir, f)),
  );

  if (isWrite) return { allowed: true };
  if (isRead) return { allowed: true, reason: "Read-only file" };

  return {
    allowed: false,
    reason: "Path is not within the allowed scope for this sub-agent",
  };
}

/**
 * Check if a path is writable (for write/delete operations)
 */
export function isPathWritable(
  baseDir: string,
  targetPath: string,
  scope?: ToolScope,
  securityConfig?: PathSecurityConfig,
): PathValidationResult {
  const baseResolved = resolve(baseDir);
  const targetResolved = resolve(baseDir, normalize(targetPath));

  // First, check that path is within baseDir
  if (!targetResolved.startsWith(baseResolved)) {
    return { allowed: false, reason: "Path is outside the base working directory" };
  }

  // Check global denied patterns
  if (securityConfig?.denied?.length) {
    for (const pattern of securityConfig.denied) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        return { allowed: false, reason: `Path matches denied pattern: ${pattern}` };
      }
    }
  }

  // Check global allowed patterns (if non-empty, only these are allowed)
  if (securityConfig?.allowed?.length) {
    let isAllowed = false;
    for (const pattern of securityConfig.allowed) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        isAllowed = true;
        break;
      }
    }
    if (!isAllowed) {
      return { allowed: false, reason: "Path does not match any allowed pattern" };
    }
  }

  // Check tool-specific scope (for subagents)
  if (!scope) {
    return { allowed: true };
  }

  const isWrite = scope.allowed_files.some((f: string) =>
    targetResolved.startsWith(resolve(baseDir, f)),
  );

  if (isWrite) return { allowed: true };

  return {
    allowed: false,
    reason: "Path is not within the writable scope for this sub-agent",
  };
}

/**
 * Simple glob pattern matching (supports * and **)
 * This is a simplified version that handles common cases
 */
function matchesGlobPattern(
  targetPath: string,
  baseDir: string,
  pattern: string,
): boolean {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedTargetPath = resolve(targetPath);
  
  // Handle directory patterns (ending with /)
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.slice(0, -1);
    const resolvedDirPattern = resolve(baseDir, dirPattern);
    
    // Exact match
    if (resolvedTargetPath === resolvedDirPattern) {
      return true;
    }
    
    // Check if target is inside the directory
    if (resolvedTargetPath.startsWith(resolvedDirPattern + "/") || resolvedTargetPath.startsWith(resolvedDirPattern + "\\")) {
      return true;
    }
    
    return false;
  }

  // Handle **/* pattern (recursive)
  if (pattern.includes("**/")) {
    const parts = pattern.split("**/");
    const prefix = parts[0];
    const suffix = parts[1];
    
    const resolvedPrefix = resolve(baseDir, prefix);
    if (!resolvedTargetPath.startsWith(resolvedPrefix + "/") && !resolvedTargetPath.startsWith(resolvedPrefix + "\\")) {
      return false;
    }
    
    const remainingPath = resolvedTargetPath.slice(resolvedPrefix.length);
    if (suffix === "*" || suffix === "") {
      return true; // Any path after prefix
    }
    
    // Check if remaining path contains the suffix
    return remainingPath.includes(suffix.replace(/\*/g, ""));
  }

  // Handle ** pattern (recursive any)
  if (pattern.includes("**")) {
    const parts = pattern.split("**");
    const prefix = parts[0];
    const suffix = parts[1];
    
    const resolvedPrefix = resolve(baseDir, prefix);
    if (!resolvedTargetPath.startsWith(resolvedPrefix + "/") && !resolvedTargetPath.startsWith(resolvedPrefix + "\\")) {
      return false;
    }
    
    if (!suffix) {
      return true; // ** at the end matches anything after prefix
    }
    
    return resolvedTargetPath.includes(suffix.replace(/\//g, ""));
  }

  // Handle * pattern (single level)
  if (pattern.includes("*")) {
    const regexPattern = pattern
      .replace(/\*/g, "[^/\\\\]*")
      .replace(/\?/g, ".")
      .replace(/\./g, "\\.");
    
    const regex = new RegExp(`^${regexPattern}$`);
    const relativePath = resolvedTargetPath.slice(resolvedBaseDir.length + 1).replace(/\\/g, "/");
    return regex.test(relativePath);
  }

  // Exact match
  return resolvedTargetPath === resolve(baseDir, pattern);
}
