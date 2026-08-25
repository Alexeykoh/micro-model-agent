import { join, resolve } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync } from "fs";
import type { SecurityConfig, AppConfig } from "../../config/types";
import { DEFAULT_SECURITY_CONFIG } from "../../config/security";
import { isInsideDir } from "../../tools/path-utils";

/**
 * Session isolation configuration
 */
export interface SessionIsolationConfig {
  /**
   * Enable session isolation
   * When enabled, each session has its own:
   * - Temporary directory
   * - Plugin instances
   * - Security overrides
   */
  enabled: boolean;
  /**
   * Base directory for session-specific data
   * Default: ~/.mma/sessions/<session-id>
   */
  baseDir?: string;
  /**
   * Isolate plugins per session
   */
  isolatePlugins: boolean;
  /**
   * Isolate temporary files per session
   */
  isolateTempFiles: boolean;
}

/**
 * Default session isolation configuration
 */
export const DEFAULT_SESSION_ISOLATION: SessionIsolationConfig = {
  enabled: false,
  isolatePlugins: true,
  isolateTempFiles: true,
};

/**
 * Session-specific context
 */
export interface SessionContext {
  /**
   * Unique session ID
   */
  sessionId: string;
  /**
   * Session-specific temporary directory
   */
  tempDir: string;
  /**
   * Session-specific security overrides
   */
  securityOverrides?: Partial<SecurityConfig>;
  /**
   * Session-specific working directory
   */
  workingDir: string;
}

/**
 * Create a session context with isolation
 */
export function createSessionContext(
  sessionId: string,
  projectDir: string,
  isolationConfig?: SessionIsolationConfig,
  securityOverrides?: Partial<SecurityConfig>,
): SessionContext {
  const config = { ...DEFAULT_SESSION_ISOLATION, ...isolationConfig };

  // Create session-specific temporary directory
  const baseDir = config.baseDir || join(homedir(), ".mma", "sessions", sessionId);
  const tempDir = join(baseDir, "temp");

  if (config.isolateTempFiles && !existsSync(tempDir)) {
    try {
      mkdirSync(tempDir, { recursive: true, mode: 0o700 });
    } catch {
      // If we can't create the temp dir, continue without isolation
    }
  }

  return {
    sessionId,
    tempDir,
    securityOverrides,
    workingDir: projectDir,
  };
}

/**
 * Get session-specific security configuration
 * Merges global security config with session overrides
 */
export function getSessionSecurityConfig(
  globalConfig: AppConfig,
  sessionContext?: SessionContext,
): SecurityConfig {
  const globalSecurity = globalConfig.security || DEFAULT_SECURITY_CONFIG;
  const sessionOverrides = sessionContext?.securityOverrides;

  if (!sessionOverrides) {
    return globalSecurity;
  }

  return {
    ...globalSecurity,
    ...sessionOverrides,
    // Merge nested objects
    bash: { ...globalSecurity.bash, ...sessionOverrides.bash },
    paths: { ...globalSecurity.paths, ...sessionOverrides.paths },
    network: { ...globalSecurity.network, ...sessionOverrides.network },
    rateLimits: { ...globalSecurity.rateLimits, ...sessionOverrides.rateLimits },
    contentScan: { ...globalSecurity.contentScan, ...sessionOverrides.contentScan },
  };
}

/**
 * Get session-specific temporary directory
 */
export function getSessionTempDir(sessionContext: SessionContext): string {
  return sessionContext.tempDir;
}

/**
 * Clean up session-specific temporary data
 */
export function cleanupSessionTempDir(sessionContext: SessionContext): void {
  // Note: In a real implementation, we would recursively delete the temp dir
  // For now, we just leave it as the OS will clean up eventually
  // In production, you might want to implement proper cleanup
}

/**
 * Create a session-specific file path
 * Ensures the path is within the session's working directory or temp directory
 */
export function createSessionFilePath(
  sessionContext: SessionContext,
  relativePath: string,
  useTempDir: boolean = false,
): string {
  const baseDir = useTempDir ? sessionContext.tempDir : sessionContext.workingDir;
  return resolve(baseDir, relativePath);
}

/**
 * Check if a path is within the session's allowed directories
 */
export function isPathInSessionScope(sessionContext: SessionContext, path: string): boolean {
  const resolvedPath = resolve(path);
  const workingDir = resolve(sessionContext.workingDir);
  const tempDir = resolve(sessionContext.tempDir);

  return isInsideDir(resolvedPath, workingDir) || isInsideDir(resolvedPath, tempDir);
}
