import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitToolResult } from "../../src/tools/admission";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-admit-trunc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Формат маркера, который добавляет плагин press-f-tasks до попадания вывода в MMA.
const partial = `${"x".repeat(12000)}\n... truncated (5000 more chars)`;

function admitPartial() {
  return admitToolResult(
    { success: true, output: partial },
    { baseDir: dir, sessionId: "s1", maxTokens: 10, source: "tasks.list" },
  );
}

describe("upstream-truncated tool output", () => {
  it("marks the artifact as a partial fragment and does not promise a full re-read", () => {
    const r = admitPartial();
    expect(r.output).toContain("truncated upstream");
    expect(r.output).toContain("5000");
    expect(r.output).not.toContain("Inspect it with read_file");
    expect(r.output).not.toContain("chunk_query");
    expect(readFileSync(r.artifactPath as string, "utf8")).toBe(partial);
  });

  it("reports digest and size of the fragment, not of an unavailable full output", () => {
    const r = admitPartial();
    expect(r.output).toContain(`sha256:${createHash("sha256").update(partial).digest("hex")}`);
    expect(r.output).toContain(`${Buffer.byteLength(partial, "utf8")} bytes`);
  });

  it("keeps the usual descriptor for a complete large output", () => {
    const full = "y".repeat(12000);
    const r = admitToolResult(
      { success: true, output: full },
      { baseDir: dir, sessionId: "s1", maxTokens: 10 },
    );
    expect(r.output).toContain("Inspect it with read_file");
    expect(r.output).not.toContain("truncated upstream");
  });
});
