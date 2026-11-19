import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedE2EConfigDir, ARTIFACTS_ROOT, REPO_ROOT } from "./web-harness";

describe("e2e web harness (no spawn, no browser)", () => {
  it("seeds a non-virgin config.json into an isolated dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-harness-unit-"));
    try {
      const path = seedE2EConfigDir(dir);
      expect(existsSync(path)).toBe(true);
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(typeof raw.model).toBe("string");
      expect(raw.provider).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps artifacts and repo root inside the project sandbox", () => {
    expect(ARTIFACTS_ROOT.startsWith(REPO_ROOT)).toBe(true);
    expect(ARTIFACTS_ROOT).toContain("_testing");
  });
});
