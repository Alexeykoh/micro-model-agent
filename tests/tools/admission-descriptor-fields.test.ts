import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { admitToolResult, artifactHandle } from "../../src/tools/admission";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-descriptor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("admission descriptor fields", () => {
  it("carries bytes, sha256 digest and a stable handle", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const result = admitToolResult(
      { success: true, output: big },
      { baseDir: dir, sessionId: "s1", maxTokens: 10 },
    );
    const artifact = result.artifactPath as string;
    const digest = createHash("sha256").update(big).digest("hex");
    const bytes = Buffer.byteLength(big, "utf8");
    const handle = artifactHandle(dir, artifact);

    expect(result.output).toContain(`${bytes} bytes`);
    expect(result.output).toContain(`sha256:${digest}`);
    expect(result.output).toContain(`Handle: ${handle}`);
    expect(artifactHandle(dir, artifact)).toBe(handle);
    expect(resolve(dir, handle)).toBe(resolve(artifact));
  });

  it("keeps the handle relative to the workspace on Windows separators", () => {
    const artifact = join(dir, ".mma", "context", "s1", "a.txt");
    expect(artifactHandle(dir, artifact)).toBe(".mma/context/s1/a.txt");
  });
});
