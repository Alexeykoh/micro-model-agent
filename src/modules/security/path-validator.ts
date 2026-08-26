import { resolve, normalize } from "path";
import { realpathSync } from "fs";
import { isInsideDir, matchesScopeEntry, toForwardSlash } from "../../tools/path-utils";
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
 * Symlink containment: resolve() does NOT follow symlinks, so a symlink
 * inside baseDir can point outside it. When the target exists on disk its
 * real path must also stay inside the (real) base directory. Returns true if
 * the check cannot be performed (target missing) — creation is validated by
 * the resolved path itself.
 */
function escapesViaSymlink(baseResolved: string, targetResolved: string): boolean {
  try {
    const realTarget = realpathSync(targetResolved);
    let realBase = baseResolved;
    try {
      realBase = realpathSync(baseResolved);
    } catch {
      // Keep the resolved baseDir when it cannot be canonicalized.
    }
    return !isInsideDir(realTarget, realBase);
  } catch {
    // ENOENT etc — target does not exist yet, nothing to follow.
    return false;
  }
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

  // First, check that path is within baseDir (separator- and case-safe: a
  // sibling directory sharing the prefix must not pass).
  if (!isInsideDir(targetResolved, baseResolved)) {
    return {
      allowed: false,
      reason: "Path is outside the base working directory",
    };
  }
  if (escapesViaSymlink(baseResolved, targetResolved)) {
    return {
      allowed: false,
      reason: "Path resolves outside the base working directory via symlink",
    };
  }

  // If security is disabled, skip pattern validation
  if (!securityConfig?.enabled) {
    // Still enforce subagent scope if present
    if (scope) {
      const isReadScope = scope.read_only_files.some((f: string) =>
        matchesScopeEntry(targetResolved, resolve(baseDir, f)),
      );
      const isWriteScope = scope.allowed_files.some((f: string) =>
        matchesScopeEntry(targetResolved, resolve(baseDir, f)),
      );
      if (isWriteScope) return { allowed: true };
      if (isReadScope) return { allowed: true, reason: "Read-only file" };
      return {
        allowed: false,
        reason: "Path is not within the allowed scope for this sub-agent",
      };
    }
    return { allowed: true };
  }

  // Check global denied patterns
  if (securityConfig?.denied?.length) {
    for (const pattern of securityConfig.denied) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        return {
          allowed: false,
          reason: `Path matches denied pattern: ${pattern}`,
        };
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
      return {
        allowed: false,
        reason: "Path does not match any allowed pattern",
      };
    }
  }

  // Check tool-specific scope (for subagents)
  if (!scope) {
    return { allowed: true };
  }

  const isRead = scope.read_only_files.some((f: string) =>
    matchesScopeEntry(targetResolved, resolve(baseDir, f)),
  );
  const isWrite = scope.allowed_files.some((f: string) =>
    matchesScopeEntry(targetResolved, resolve(baseDir, f)),
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

  // First, check that path is within baseDir (separator- and case-safe: a
  // sibling directory sharing the prefix must not pass).
  if (!isInsideDir(targetResolved, baseResolved)) {
    return {
      allowed: false,
      reason: "Path is outside the base working directory",
    };
  }

  // If security is disabled, skip pattern validation
  if (!securityConfig?.enabled) {
    // Still enforce subagent scope if present
    if (scope) {
      const isWriteScope = scope.allowed_files.some((f: string) =>
        matchesScopeEntry(targetResolved, resolve(baseDir, f)),
      );
      if (isWriteScope) return { allowed: true };
      return {
        allowed: false,
        reason: "Path is not within the allowed scope for this sub-agent",
      };
    }
    return { allowed: true };
  }

  // Check global denied patterns
  if (securityConfig?.denied?.length) {
    for (const pattern of securityConfig.denied) {
      if (matchesGlobPattern(targetResolved, baseDir, pattern)) {
        return {
          allowed: false,
          reason: `Path matches denied pattern: ${pattern}`,
        };
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
      return {
        allowed: false,
        reason: "Path does not match any allowed pattern",
      };
    }
  }

  // Check tool-specific scope (for subagents)
  if (!scope) {
    return { allowed: true };
  }

  const isWrite = scope.allowed_files.some((f: string) =>
    matchesScopeEntry(targetResolved, resolve(baseDir, f)),
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
function matchesGlobPattern(targetPath: string, baseDir: string, pattern: string): boolean {
  const resolvedBaseDir = resolve(baseDir);
  const resolvedTargetPath = resolve(targetPath);

  // Relative target path used for segment matching
  const relPath = resolvedTargetPath.startsWith(resolvedBaseDir)
    ? resolvedTargetPath.slice(resolvedBaseDir.length).replace(/^\//, "")
    : resolvedTargetPath;

  // Handle patterns with ** (recursive directory matching)
  if (pattern.includes("**")) {
    // Split on ** to get prefix/suffix segments
    const cleaned = pattern.replace(/\/$/, "");
    const [rawPrefix, rawSuffix] = cleaned.split("**");
    const prefix = rawPrefix.replace(/\/$/, "");
    const suffix = rawSuffix.replace(/^\//, "");

    // Check prefix: everything before ** must match the start of the path
    if (prefix) {
      const prefixParts = prefix.split("/").filter(Boolean);
      const relParts = relPath.split("/");
      for (let i = 0; i < prefixParts.length; i++) {
        if (relParts[i] !== prefixParts[i]) return false;
      }
    }

    // ** at the end matches everything
    if (!suffix) return true;

    // Check suffix against remaining path segments
    const suffixParts = suffix.split("/").filter(Boolean);
    const relParts = relPath.split("/");
    // Search for suffix match anywhere in remaining path
    for (let start = (prefix ? prefix.split("/").filter(Boolean).length : 0); start <= relParts.length - suffixParts.length; start++) {
      let match = true;
      for (let j = 0; j < suffixParts.length; j++) {
        if (suffixParts[j] === "*") continue;
        if (relParts[start + j] !== suffixParts[j]) { match = false; break; }
      }
      if (match) return true;
    }
    return false;
  }

  // Handle directory patterns (ending with /) without **
  if (pattern.endsWith("/")) {
    const dirPattern = pattern.slice(0, -1);
    const resolvedDirPattern = resolve(baseDir, dirPattern);
    return isInsideDir(resolvedTargetPath, resolvedDirPattern);
  }

  // Handle * pattern (single level) without **
  if (pattern.includes("*")) {
    const regexPattern = pattern
      .replace(/\*/g, "[^/\\\\]*")
      .replace(/\?/g, ".")
      .replace(/\./g, "\\.");

    const regex = new RegExp(`^${regexPattern}$`);
    const relativePath = toForwardSlash(resolvedTargetPath.slice(resolvedBaseDir.length + 1));
    return regex.test(relativePath);
  }

  // Exact match (case-insensitive on win32, where the FS is case-insensitive)
  const exactTarget = resolve(baseDir, pattern);
  if (process.platform === "win32") {
    return resolvedTargetPath.toLowerCase() === exactTarget.toLowerCase();
  }
  return resolvedTargetPath === exactTarget;
}
