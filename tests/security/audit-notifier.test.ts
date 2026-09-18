import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  AuditNotifier,
  globalAuditNotifier,
  DEFAULT_AUDIT_NOTIFIER_CONFIG,
  type AuditNotifierConfig,
} from "../../src/modules/security/audit-notifier";
import type { AuditLogEntry } from "../../src/modules/security/audit-log";
import { defaultOutputBus, type OutputEvent } from "../../src/output";

const TEST_DIR = join(__dirname, "test-audit-notifier");
const TEST_FILE = join(TEST_DIR, "audit-notifications.jsonl");

describe("AuditNotifier", () => {
  let notifier: AuditNotifier;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("Configuration", () => {
    it("should be disabled by default", () => {
      notifier = new AuditNotifier();
      expect(notifier.isEnabled()).toBe(false);
    });

    it("should be enabled when configured", () => {
      const config: Partial<AuditNotifierConfig> = { enabled: true };
      notifier = new AuditNotifier(config);
      expect(notifier.isEnabled()).toBe(true);
    });

    it("should enable/disable dynamically", () => {
      notifier = new AuditNotifier();
      expect(notifier.isEnabled()).toBe(false);
      notifier.enable();
      expect(notifier.isEnabled()).toBe(true);
      notifier.disable();
      expect(notifier.isEnabled()).toBe(false);
    });

    it("should update configuration", () => {
      notifier = new AuditNotifier({ enabled: true });
      notifier.updateConfig({ minSeverity: "high" });
      const config = (notifier as any).config;
      expect(config.minSeverity).toBe("high");
    });

    it("should use default file path", () => {
      notifier = new AuditNotifier();
      const config = (notifier as any).config;
      expect(config.filePath).toContain(".mma");
      expect(config.filePath).toContain("audit-notifications.jsonl");
    });

    it("should use custom file path", () => {
      notifier = new AuditNotifier({ filePath: TEST_FILE });
      const config = (notifier as any).config;
      expect(config.filePath).toBe(TEST_FILE);
    });
  });

  describe("Event filtering", () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ["security_block", "bash_command"],
        minSeverity: "medium",
      });
    });

    it("should notify for configured event types", () => {
      expect(notifier.shouldNotify("security_block" as any)).toBe(true);
    });

    it("should not notify for unconfigured event types", () => {
      expect(notifier.shouldNotify("file_operation" as any)).toBe(false);
    });

    it("should notify for severity above minimum", () => {
      expect(notifier.shouldNotifySeverity("high")).toBe(true);
      expect(notifier.shouldNotifySeverity("critical")).toBe(true);
      expect(notifier.shouldNotifySeverity("medium")).toBe(true);
      expect(notifier.shouldNotifySeverity("low")).toBe(false);
    });

    it("should determine severity from event action", () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "security_block",
        details: "Test",
        success: true,
      };
      const severity = (notifier as any).determineSeverity(entry);
      expect(severity).toBe("high");
    });

    it("should map event actions correctly", () => {
      const mapper = (notifier as any).mapEventType;
      expect(mapper("security_block")).toBe("security_block");
      expect(mapper("bash_command")).toBe("bash_command");
      expect(mapper("file_write")).toBe("file_operation");
      expect(mapper("unknown")).toBeNull();
    });
  });

  describe("Notification sending", () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ["security_block", "bash_command", "file_operation"],
        minSeverity: "low",
      });
    });

    it("should return null when disabled", async () => {
      notifier.disable();
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "security_block",
        details: "Test",
        success: true,
      };
      const result = await notifier.notify(entry);
      expect(result).toBeNull();
    });

    it("should return null for unconfigured event types", async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "network_request",
        details: "Test",
        success: true,
      };
      const result = await notifier.notify(entry);
      expect(result).toBeNull();
    });

    it("should return null for low severity when min is medium", async () => {
      notifier.updateConfig({ minSeverity: "medium" });
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "tool_call",
        details: "Test",
        success: true,
      };
      const result = await notifier.notify(entry);
      expect(result).toBeNull();
    });

    it("should write to file when configured", async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "security_block",
        details: "Blocked command",
        success: true,
      };
      await notifier.notify(entry);

      expect(existsSync(TEST_FILE)).toBe(true);
      const content = readFileSync(TEST_FILE, "utf8");
      expect(content).toContain("security_block");
      expect(content).toContain("Blocked command");
    });

    it("should return notification object on success", async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "security_block",
        details: "Blocked command",
        success: true,
        sessionId: "ses-123",
      };
      const result = await notifier.notify(entry);

      expect(result).not.toBeNull();
      expect(result?.eventType).toBe("security_block");
      expect(result?.severity).toBe("high");
      expect(result?.message).toBe("Blocked command");
      expect(result?.sessionId).toBe("ses-123");
    });

    it("should drain the retry queue after maxRetries (no infinite loop, no duplicates)", async () => {
      let calls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls++;
        return new Response("err", { status: 500 });
      }) as typeof fetch;
      vi.useFakeTimers();
      try {
        notifier.updateConfig({ webhookUrl: "http://localhost:1/hook", maxRetries: 2 });
        const entry: AuditLogEntry = {
          timestamp: new Date().toISOString(),
          action: "security_block",
          details: "Blocked command",
          success: true,
        };
        await notifier.notify(entry);
        // Flush the background retry processor through its exponential
        // backoff sleeps: microtask flush + synchronous timer drain, until
        // the queue gives up (bounded iterations guard against a regression
        // to the infinite-loop bug).
        for (let i = 0; i < 20 && calls < 3; i++) {
          await Promise.resolve();
          await Promise.resolve();
          vi.runAllTimers();
          await Promise.resolve();
        }

        // 1 initial attempt + maxRetries retries; a copy-with-reset-retries
        // bug would loop forever and never settle.
        expect(calls).toBe(3);
      } finally {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("File operations", () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ["security_block"],
        minSeverity: "low",
      });
    });

    it("should read notifications from file", async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "security_block",
        details: "Test 1",
        success: true,
      };
      await notifier.notify(entry);

      const notifications = notifier.readNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].message).toBe("Test 1");
    });

    it("should read limited number of notifications", async () => {
      for (let i = 0; i < 5; i++) {
        const entry: AuditLogEntry = {
          timestamp: new Date().toISOString(),
          action: "security_block",
          details: `Test ${i}`,
          success: true,
        };
        await notifier.notify(entry);
      }

      const notifications = notifier.readNotifications(3);
      expect(notifications).toHaveLength(3);
    });

    it("should clear notifications", async () => {
      const entry: AuditLogEntry = {
        timestamp: new Date().toISOString(),
        action: "security_block",
        details: "Test",
        success: true,
      };
      await notifier.notify(entry);

      notifier.clearNotifications();

      const notifications = notifier.readNotifications();
      expect(notifications).toHaveLength(0);
    });

    it("should return empty array for non-existent file", () => {
      const notifications = notifier.readNotifications();
      expect(notifications).toEqual([]);
    });

    it("marks read-failure diagnostics for session persistence", () => {
      writeFileSync(TEST_FILE, "not valid json\n", "utf8");
      const events: OutputEvent[] = [];
      const unsub = defaultOutputBus.subscribe((ev) => events.push(ev));
      try {
        notifier.readNotifications();
      } finally {
        unsub();
      }

      const ev = events.find((e) => e.source === "audit" && e.level === "error");
      expect(ev).toBeDefined();
      expect(ev?.data).toMatchObject({ persist: true });
    });
  });

  describe("Statistics", () => {
    beforeEach(() => {
      notifier = new AuditNotifier({
        enabled: true,
        filePath: TEST_FILE,
        eventTypes: ["security_block", "bash_command", "file_operation"],
        minSeverity: "low",
      });
    });

    it("should return correct statistics", async () => {
      // Use actions that map to our configured event types
      const entries: AuditLogEntry[] = [
        {
          timestamp: new Date().toISOString(),
          action: "security_block",
          details: "Block 1",
          success: true,
        },
        {
          timestamp: new Date().toISOString(),
          action: "security_block",
          details: "Block 2",
          success: true,
        },
        {
          timestamp: new Date().toISOString(),
          action: "bash_command",
          details: "Bash 1",
          success: true,
        },
        {
          timestamp: new Date().toISOString(),
          action: "file_write",
          details: "File 1",
          success: true,
        },
      ];

      for (const entry of entries) {
        await notifier.notify(entry);
      }

      const stats = notifier.getStats();
      // All 4 entries should be written since we configured all these event types
      expect(stats.total).toBe(4);
      // security_block (2) = high, bash_command (1) = high, file_write (1) = medium
      expect(stats.bySeverity.high).toBe(3);
      expect(stats.bySeverity.medium).toBe(1);
      expect(stats.bySeverity.low).toBe(0);
      expect(stats.bySeverity.critical).toBe(0);
      expect(stats.byType.security_block).toBe(2);
      expect(stats.byType.bash_command).toBe(1);
      expect(stats.byType.file_operation).toBe(1);
    });
  });

  describe("Default configuration", () => {
    it("should have correct default values", () => {
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.enabled).toBe(false);
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.minSeverity).toBe("medium");
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.eventTypes).toContain("security_block");
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_AUDIT_NOTIFIER_CONFIG.webhookTimeout).toBe(5000);
    });
  });

  describe("Global instance", () => {
    it("should have a global instance", () => {
      expect(globalAuditNotifier).toBeInstanceOf(AuditNotifier);
      expect(globalAuditNotifier.isEnabled()).toBe(false);
    });
  });
});
