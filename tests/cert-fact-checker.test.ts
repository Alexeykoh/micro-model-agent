import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkSandbox } from "../src/modules/certification/fact-checker";
import type { CertCheck } from "../src/modules/certification/types";

function makeSandbox(files: Record<string, string>): string {
  const dir = join(tmpdir(), `cert-fc-${Math.random().toString(36).slice(2)}`);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("fact-checker", () => {
  it("fileExists passes only when file present", () => {
    const dir = makeSandbox({ "a.ts": "x" });
    expect(checkSandbox(dir, [{ type: "fileExists", path: "a.ts" }], 0, "").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "fileExists", path: "b.ts" }], 0, "").pass).toBe(false);
  });

  it("fileNotExists passes only when file absent", () => {
    const dir = makeSandbox({ "a.ts": "x" });
    expect(checkSandbox(dir, [{ type: "fileNotExists", path: "a.ts" }], 0, "").pass).toBe(false);
    expect(checkSandbox(dir, [{ type: "fileNotExists", path: "b.ts" }], 0, "").pass).toBe(true);
  });

  it("dirExists passes for directories", () => {
    const dir = makeSandbox({ "src/util.ts": "x" });
    expect(checkSandbox(dir, [{ type: "dirExists", path: "src" }], 0, "").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "dirExists", path: "nope" }], 0, "").pass).toBe(false);
  });

  it("fileContent contains and equals", () => {
    const dir = makeSandbox({ "m.ts": 'export const msg = "Hi";' });
    expect(checkSandbox(dir, [{ type: "fileContent", path: "m.ts", contains: "Hi" }], 0, "").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "fileContent", path: "m.ts", contains: "bye" }], 0, "").pass).toBe(false);
    expect(checkSandbox(dir, [{ type: "fileContent", path: "m.ts", equals: 'export const msg = "Hi";' }], 0, "").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "fileContent", path: "m.ts", equals: "other" }], 0, "").pass).toBe(false);
  });

  it("fileRegex matches content", () => {
    const dir = makeSandbox({ "m.ts": "console.log(x)" });
    expect(checkSandbox(dir, [{ type: "fileRegex", path: "m.ts", pattern: "console\\.log" }], 0, "").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "fileRegex", path: "m.ts", pattern: "^zzz" }], 0, "").pass).toBe(false);
  });

  it("exitCode check", () => {
    const dir = makeSandbox({});
    expect(checkSandbox(dir, [{ type: "exitCode", code: 0 }], 0, "").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "exitCode", code: 0 }], 1, "").pass).toBe(false);
  });

  it("outputContains greps combined output", () => {
    const dir = makeSandbox({});
    expect(checkSandbox(dir, [{ type: "outputContains", text: "blocked" }], 0, "request was blocked").pass).toBe(true);
    expect(checkSandbox(dir, [{ type: "outputContains", text: "blocked" }], 0, "all fine").pass).toBe(false);
  });

  it("all checks must pass (AND semantics)", () => {
    const dir = makeSandbox({ "a.ts": "x" });
    const checks: CertCheck[] = [
      { type: "fileExists", path: "a.ts" },
      { type: "fileExists", path: "b.ts" },
    ];
    const res = checkSandbox(dir, checks, 0, "");
    expect(res.pass).toBe(false);
    expect(res.failures.length).toBeGreaterThan(0);
  });
});