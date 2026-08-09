import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { FactualCheck } from "../src/modules/hallucination/factual";

describe("FactualCheck", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-factual-"));
    writeFileSync(join(dir, "config.json"), "{}");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    mkdirSync(join(dir, "src", "data"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1");
    writeFileSync(join(dir, "src", "utils", "helper.ts"), "export const y = 2");
    writeFileSync(join(dir, "src", "data", "bikes.json"), "{}");
    writeFileSync(join(dir, "SECURITY.md"), "# Security");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes when a bare file name exists in a subdirectory", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Bike data lives in bikes.json");
    expect(result.status).toBe("pass");
  });

  it("passes when a bare file name exists only in a nested subdirectory", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("See helper.ts for details");
    expect(result.status).toBe("pass");
  });

  it("passes when absolute Windows path matches an existing file", () => {
    const check = new FactualCheck(dir);
    const win = `${dir.replace(/\//g, "\\")}\\config.json`;
    const result = check.validate(`Created ${win} and SECURITY.md`);
    expect(result.status).toBe("pass");
  });

  it("warns for a fake absolute Windows path", () => {
    const check = new FactualCheck(dir);
    const fake = `${dir.replace(/\//g, "\\")}\\ghost.ts`;
    const result = check.validate(`Wrote ${fake}`);
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("ghost.ts");
  });

  it("does not flag technology names like Node.js", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Used Node.js runtime for the build");
    expect(result.status).toBe("pass");
  });

  it("passes for existing relative paths", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("See src/index.ts and src/utils/helper.ts");
    expect(result.status).toBe("pass");
  });

  it("warns for a missing relative path", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Created src/ghost.ts");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("src/ghost.ts");
  });

  it("warns for a bare file name that exists nowhere", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Updated phantom.json");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("phantom.json");
  });

  it("passes on a response with no file paths", () => {
    const check = new FactualCheck(dir);
    const result = check.validate("Everything is done, no issues.");
    expect(result.status).toBe("pass");
  });
});
