import { describe, expect, it } from "bun:test";
import { FilePathProvider } from "../../src/cli/completer";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("FilePathProvider", () => {
  it("should complete file paths from CWD", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mma-completer-"));
    mkdirSync(join(tempDir, "src"));
    writeFileSync(join(tempDir, "src", "test.ts"), "");

    const originalCwd = process.cwd();
    process.chdir(tempDir);

    const provider = new FilePathProvider();
    const ctx = {
      line: "read src/",
      cursor: 9,
      tokens: ["read", "src/"],
      partial: "src/",
      tokenIndex: 1,
    };

    const matches = provider.complete(ctx).map((m) => m.value);

    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((m) => m.includes("src"))).toBe(true);
  });
});
