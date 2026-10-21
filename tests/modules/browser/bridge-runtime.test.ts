import { describe, it, expect } from "vitest";
import { resolveRuntime, findExecutable } from "../../../src/modules/browser/bridge-runtime";

/**
 * Мост браузера должен стартовать на доступном рантайме (Bun предпочтительно),
 * а при отсутствии обоих — дать понятную инструкцию (аудит §2.4, план
 * `2026-10-12-harness-module-audit-fixes`, W4/Task 4.4).
 */

describe("resolveRuntime", () => {
  it("prefers node when it is on PATH", () => {
    const choice = resolveRuntime({ isBun: true, pathExists: () => true });
    expect(choice).toEqual({ runtime: "node" });
  });

  it("falls back to bun when node is missing", () => {
    const choice = resolveRuntime({ isBun: true, pathExists: () => false });
    expect(choice).toEqual({ runtime: "bun" });
  });

  it("fails with an actionable message when neither runtime exists", () => {
    const choice = resolveRuntime({ isBun: false, pathExists: () => false });
    expect("error" in choice).toBe(true);
    if ("error" in choice) {
      expect(choice.error).toContain("bunx playwright install chromium");
      expect(choice.error).toContain("neither bun nor node");
    }
  });

  it("findExecutable scans PATH", () => {
    expect(findExecutable("definitely-not-a-real-binary-xyz")).toBe(false);
  });
});
