import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectPackageManager,
  detectProjectCommands,
  fallbackPromptFacts,
  localNow,
} from "../../src/core/prompt-facts";
import { DEFAULTS } from "../../src/config/defaults";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mma-prompt-facts-"));
}

describe("prompt facts: project detection", () => {
  it("prefers bun.lock over package-lock.json", () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "bun.lock"), "");
      writeFileSync(join(dir, "package-lock.json"), "{}");
      expect(detectPackageManager(dir)).toBe("bun");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects npm from package-lock.json", () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "package-lock.json"), "{}");
      expect(detectPackageManager(dir)).toBe("npm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the project's own test and typecheck scripts", () => {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
      );
      expect(detectProjectCommands(dir, "npm")).toEqual({
        testCommand: "npm test",
        typecheckCommand: "npm run typecheck",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to tsc only when TypeScript is installed locally", () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      mkdirSync(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "typescript", "bin", "tsc"), "");
      expect(detectProjectCommands(dir, "bun")).toEqual({
        testCommand: undefined,
        typecheckCommand: "tsc --noEmit",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not invent tsc when TypeScript is not installed", () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "tsconfig.json"), "{}");
      expect(detectProjectCommands(dir, "bun")).toEqual({
        testCommand: undefined,
        typecheckCommand: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("prompt facts: safe fallback", () => {
  it("does not claim tools that were not probed", () => {
    const f = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp", "linux");
    expect(f.tools).toEqual({ bun: "unknown", git: "unknown", python: "unknown" });
    expect(f.platform).toBe("linux");
    expect(f.shell).toBe("sh");
  });

  it("renders local time with an offset", () => {
    const now = localNow(new Date("2026-10-31T12:34:56Z"));
    expect(now.iso).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}/);
    expect(now.timeZone.length).toBeGreaterThan(0);
  });
});
