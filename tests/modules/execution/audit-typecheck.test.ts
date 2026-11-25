import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTypecheck } from "../../../src/modules/execution/audit-runners";
import { auditEntry } from "../../../src/core/session-log-messages";
import { processRegistry } from "../../../src/modules/processes";

/** INV-15 / спека 2026-10-30 §7: tsc timeout и «нет ошибок» — разные исходы. */
describe("audit typecheck result", () => {
  it("reports inconclusive with a reason when tsc is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-typecheck-none-"));
    try {
      const result = await runTypecheck(dir);
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toContain("tsc");
      expect(typeof result.durationMs).toBe("number");
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports inconclusive on timeout instead of silently returning ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-typecheck-timeout-"));
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), "");
    const start = vi
      .spyOn(processRegistry, "start")
      .mockReturnValue({ id: "fake-tsc", log: [] } as never);
    const wait = vi.spyOn(processRegistry, "waitForExit").mockResolvedValue(false);
    const remove = vi.spyOn(processRegistry, "remove").mockImplementation(() => {});
    try {
      const result = await runTypecheck(dir);
      expect(result.status).toBe("inconclusive");
      expect(result.reason).toContain("timeout");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      start.mockRestore();
      wait.mockRestore();
      remove.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the typecheck status with reason and duration into the audit log entry", () => {
    const entry = auditEntry("ok", 1, 12, undefined, {
      status: "inconclusive",
      reason: "tsc timeout after 90000ms",
      durationMs: 90000,
    });
    expect(entry).toMatchObject({
      type: "audit",
      typecheck: {
        status: "inconclusive",
        reason: "tsc timeout after 90000ms",
        durationMs: 90000,
      },
    });
  });
});
