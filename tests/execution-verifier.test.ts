import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { StepVerifier } from "../src/modules/execution/verifier";

describe("StepVerifier", () => {
  let tmpDir: string;
  let verifier: StepVerifier;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-verify-"));
    verifier = new StepVerifier(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("should pass when file exists", async () => {
    writeFileSync(join(tmpDir, "test.txt"), "content");
    const result = await verifier.checkFileExists("test.txt");
    expect(result.passed).toBe(true);
  });

  it("should fail when file missing", async () => {
    const result = await verifier.checkFileExists("nonexistent.txt");
    expect(result.passed).toBe(false);
  });

  it("should check all files from step descriptions", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src/index.ts"), "");
    const result = await verifier.verifyStep("Create src/index.ts and src/utils.ts");
    expect(result.failed.length).toBeGreaterThan(0);
  });

  it("should verify artifact files", async () => {
    writeFileSync(join(tmpDir, "output.txt"), "content");
    const results = await verifier.verifyArtifactFiles(["output.txt", "missing.txt"]);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });


});
