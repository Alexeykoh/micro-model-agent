import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitToolResult } from "../../src/tools/admission";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-admit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("admitToolResult", () => {
  it("passes small output through untouched", () => {
    const r = admitToolResult(
      { success: true, output: "hello" },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000 },
    );
    expect(r.output).toBe("hello");
    expect(r.artifactPath).toBeUndefined();
  });

  it("spills large output and returns a descriptor with a preview", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const r = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 3000, source: "big.txt" },
    );
    expect(r.output).not.toContain("line 4999");
    expect(r.output).toContain("big.txt");
    expect(r.output).toContain("line 0");
    expect(r.artifactPath).toBeTruthy();
    expect(readFileSync(r.artifactPath as string, "utf8")).toBe(big);
  });

  it("does not admit failed results", () => {
    const big = "x".repeat(100000);
    const r = admitToolResult(
      { success: false, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 100 },
    );
    expect(r.output).toBe(big);
    expect(r.artifactPath).toBeUndefined();
  });
});
