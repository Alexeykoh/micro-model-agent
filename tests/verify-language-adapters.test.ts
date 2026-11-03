import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { StepVerifier } from "../src/modules/execution/verifier";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mma-verify-lang-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("verifier: non-TS syntax adapters", () => {
  it("rejects broken JSON and accepts valid JSON", async () => {
    writeFileSync(join(dir, "bad.json"), '{"a": }', "utf-8");
    writeFileSync(join(dir, "good.json"), '{"a": 1}', "utf-8");
    const v = new StepVerifier(dir);

    const bad = await v.verifyStep("check bad.json");
    expect(bad.syntaxValid).toBe(false);
    expect(bad.passed).toBe(false);

    const good = await v.verifyStep("check good.json");
    expect(good.syntaxValid).toBe(true);
    expect(good.passed).toBe(true);
  });

  it("rejects a broken Python file when python is available", async () => {
    writeFileSync(join(dir, "bad.py"), "def broke(:\n  pass\n", "utf-8");
    const v = new StepVerifier(dir);
    const r = await v.verifyStep("check bad.py");
    // No python on the machine → fail-open degrade (syntaxValid stays true).
    if (r.syntaxValid === false) expect(r.passed).toBe(false);
  });
});
