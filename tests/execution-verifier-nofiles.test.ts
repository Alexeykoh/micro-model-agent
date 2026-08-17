import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { StepVerifier } from "../src/modules/execution/verifier";

describe("StepVerifier — noFiles detection", () => {
  let tmpDir: string;
  let verifier: StepVerifier;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mma-verify-nofiles-"));
    verifier = new StepVerifier(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("returns noFiles when the description has no file-like tokens", async () => {
    const result = await verifier.verifyStep("Run bun build and check output");
    expect(result.noFiles).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failed.length).toBe(0);
  });

  it("returns noFiles for a pure command step with no extensions", async () => {
    const result = await verifier.verifyStep("Проверить результат сборки и исправить ошибки TypeScript");
    expect(result.noFiles).toBe(true);
  });

  it("returns noFiles when description only has URLs (no file tokens after stripping)", async () => {
    const result = await verifier.verifyStep("Fetch https://example.com/data.json");
    expect(result.noFiles).toBe(true);
  });

  it("still checks file existence when tokens are present", async () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "index.ts"), "");
    const result = await verifier.verifyStep("Create src/index.ts and src/utils.ts");
    expect(result.noFiles).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.failed.length).toBeGreaterThan(0);
  });

  it("finds nested files via the subtree resolver", async () => {
    mkdirSync(join(tmpDir, "bicycle-shop", "src"), { recursive: true });
    writeFileSync(join(tmpDir, "bicycle-shop", "src", "App.tsx"), "export const App = () => null;\n");
    const result = await verifier.verifyStep("Check src/App.tsx");
    expect(result.noFiles).toBe(false);
    expect(result.passed).toBe(true);
  });

  it("does not treat JS member access as files", async () => {
    const result = await verifier.verifyStep("Use process.env and console.log");
    expect(result.noFiles).toBe(true);
  });
});
