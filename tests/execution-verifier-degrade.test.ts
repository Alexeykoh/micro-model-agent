import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { StepVerifier } from "../src/modules/execution/verifier";

/**
 * W0.6/INV-15: fail-open верификатора обязан оставить сигнал `verify_error`
 * вместо «тихого ok» — иначе «нет tsconfig/tsc» неотличимо от «проверено».
 */
describe("StepVerifier degradation signal (INV-15)", () => {
  it("reports a skipped typecheck when there is no tsconfig", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-verify-"));
    try {
      const onDegrade = vi.fn();
      const verifier = new StepVerifier(dir, onDegrade);
      const item = await verifier.runTypeCheck([]);
      expect(item.passed).toBe(true);
      expect(onDegrade).toHaveBeenCalledOnce();
      expect(onDegrade.mock.calls[0][0]).toBe("verify.typecheck");
      expect(String(onDegrade.mock.calls[0][1])).toContain("tsconfig");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports skipped tests when there is no package.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-verify-"));
    try {
      const onDegrade = vi.fn();
      const verifier = new StepVerifier(dir, onDegrade);
      const item = await verifier.runTests();
      expect(item.passed).toBe(true);
      expect(onDegrade).toHaveBeenCalledWith("verify.tests", expect.stringContaining("package"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent when no reporter is attached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-verify-"));
    try {
      const verifier = new StepVerifier(dir);
      await expect(verifier.runTypeCheck([])).resolves.toMatchObject({ passed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
