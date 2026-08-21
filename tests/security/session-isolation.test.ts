import {
  createSessionContext,
  getSessionSecurityConfig,
  isPathInSessionScope,
  createSessionFilePath,
  DEFAULT_SESSION_ISOLATION,
  SessionIsolationConfig,
} from "../../src/modules/security/session-isolation";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, mkdtempSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

describe("Session Isolation", () => {
  const testSessionId = "test-session-123";
  const isolationRoot = mkdtempSync(join(tmpdir(), "mma-session-isolation-"));
  const testProjectDir = join(isolationRoot, "test-project");
  const testTempDir = join(isolationRoot, ".mma", "sessions", testSessionId, "temp");

  beforeEach(() => {
    // Create test directories
    try {
      mkdirSync(testProjectDir, { recursive: true });
      mkdirSync(testTempDir, { recursive: true });
    } catch {
      // Ignore if directories already exist
    }
  });

  afterEach(() => {
    // Clean up test directories
    try {
      rmSync(isolationRoot, { recursive: true, force: true });
    } catch {
      // Ignore if cleanup fails
    }
  });

  describe("createSessionContext", () => {
    it("should create a session context with default isolation", () => {
      const context = createSessionContext(testSessionId, testProjectDir);

      expect(context.sessionId).toBe(testSessionId);
      expect(context.workingDir).toBe(testProjectDir);
      expect(context.tempDir).toContain(testSessionId);
      expect(context.securityOverrides).toBeUndefined();
    });

    it("should create a session context with custom isolation config", () => {
      const isolationConfig: SessionIsolationConfig = {
        enabled: true,
        isolatePlugins: false,
        isolateTempFiles: true,
      };

      const context = createSessionContext(testSessionId, testProjectDir, isolationConfig);

      expect(context.sessionId).toBe(testSessionId);
      expect(context.tempDir).toContain(testSessionId);
    });

    it("should create a session context with security overrides", () => {
      const securityOverrides = {
        maxFileOperations: 50,
        maxRecursionDepth: 2,
      };

      const context = createSessionContext(
        testSessionId,
        testProjectDir,
        undefined,
        securityOverrides,
      );

      expect(context.securityOverrides).toEqual(securityOverrides);
    });
  });

  describe("getSessionSecurityConfig", () => {
    it("should return global security config when no session context", () => {
      const globalConfig = {
        security: {
          maxFileOperations: 100,
          maxRecursionDepth: 3,
          rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: 5 },
          bash: {
            blacklist: ["rm"],
            whitelist: [],
            blockDangerousFlags: true,
            logCommands: true,
            dangerousFlags: [],
            dangerousOperators: [],
          },
          paths: { denied: [], allowed: [] },
          network: {
            deniedDomains: [],
            allowedDomains: [],
            requestTimeout: 15000,
            maxResponseSize: 15000,
          },
          contentScan: { enabled: true, dangerousPatterns: [] },
        },
      };

      const config = getSessionSecurityConfig(globalConfig as any);
      expect(config.maxFileOperations).toBe(100);
      expect(config.maxRecursionDepth).toBe(3);
    });

    it("should merge session overrides with global config", () => {
      const globalConfig = {
        security: {
          maxFileOperations: 100,
          maxRecursionDepth: 3,
          rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: 5 },
          bash: {
            blacklist: ["rm"],
            whitelist: [],
            blockDangerousFlags: true,
            logCommands: true,
            dangerousFlags: [],
            dangerousOperators: [],
          },
          paths: { denied: [], allowed: [] },
          network: {
            deniedDomains: [],
            allowedDomains: [],
            requestTimeout: 15000,
            maxResponseSize: 15000,
          },
          contentScan: { enabled: true, dangerousPatterns: [] },
        },
      };

      const sessionContext = createSessionContext(testSessionId, testProjectDir, undefined, {
        maxFileOperations: 50,
      });

      const config = getSessionSecurityConfig(globalConfig as any, sessionContext);
      expect(config.maxFileOperations).toBe(50);
      expect(config.maxRecursionDepth).toBe(3); // From global
    });

    it("should merge nested security config objects", () => {
      const globalConfig = {
        security: {
          maxFileOperations: 100,
          maxRecursionDepth: 3,
          rateLimits: { maxRequestsPerMinute: 60, maxParallelTasks: 5 },
          bash: {
            blacklist: ["rm"],
            whitelist: [],
            blockDangerousFlags: true,
            logCommands: true,
            dangerousFlags: [],
            dangerousOperators: [],
          },
          paths: { denied: [".git/"], allowed: [] },
          network: {
            deniedDomains: [],
            allowedDomains: [],
            requestTimeout: 15000,
            maxResponseSize: 15000,
          },
          contentScan: { enabled: true, dangerousPatterns: [] },
        },
      };

      const sessionContext = createSessionContext(testSessionId, testProjectDir, undefined, {
        paths: { denied: [".git/", "node_modules/"] },
      });

      const config = getSessionSecurityConfig(globalConfig as any, sessionContext);
      expect(config.paths.denied).toContain("node_modules/");
      expect(config.paths.denied).toContain(".git/");
    });
  });

  describe("isPathInSessionScope", () => {
    it("should return true for paths within working directory", () => {
      const context = createSessionContext(testSessionId, testProjectDir);
      const testFile = join(testProjectDir, "src", "index.ts");

      expect(isPathInSessionScope(context, testFile)).toBe(true);
    });

    it("should return true for paths within temp directory", () => {
      const context = createSessionContext(testSessionId, testProjectDir);
      const testFile = join(context.tempDir, "temp-file.txt");

      expect(isPathInSessionScope(context, testFile)).toBe(true);
    });

    it("should return false for paths outside working and temp directories", () => {
      const context = createSessionContext(testSessionId, testProjectDir);
      const outsidePath = join(tmpdir(), "outside", "file.txt");

      expect(isPathInSessionScope(context, outsidePath)).toBe(false);
    });

    it("should handle path normalization", () => {
      const context = createSessionContext(testSessionId, testProjectDir);
      // Create a path that resolves to within the working directory
      const testFile = resolve(join(testProjectDir, "src", "index.ts"));

      expect(isPathInSessionScope(context, testFile)).toBe(true);
    });
  });

  describe("createSessionFilePath", () => {
    it("should create path in working directory by default", () => {
      const context = createSessionContext(testSessionId, testProjectDir);
      const filePath = createSessionFilePath(context, "src/index.ts", false);

      expect(filePath).toBe(resolve(join(testProjectDir, "src", "index.ts")));
    });

    it("should create path in temp directory when requested", () => {
      const context = createSessionContext(testSessionId, testProjectDir);
      const filePath = createSessionFilePath(context, "temp-file.txt", true);

      expect(filePath).toBe(resolve(join(context.tempDir, "temp-file.txt")));
    });
  });

  describe("DEFAULT_SESSION_ISOLATION", () => {
    it("should have sensible defaults", () => {
      expect(DEFAULT_SESSION_ISOLATION.enabled).toBe(false);
      expect(DEFAULT_SESSION_ISOLATION.isolatePlugins).toBe(true);
      expect(DEFAULT_SESSION_ISOLATION.isolateTempFiles).toBe(true);
    });
  });
});
