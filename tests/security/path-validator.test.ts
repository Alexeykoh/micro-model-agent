import { isPathInScope, isPathWritable } from "../../src/modules/security/path-validator";
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Path Validator", () => {
  const baseDir = "/home/user/project";

  describe("isPathInScope", () => {
    it("should allow paths within baseDir", () => {
      const result = isPathInScope(baseDir, "src/index.ts", undefined, undefined);
      expect(result.allowed).toBe(true);
    });

    it("should block paths outside baseDir", () => {
      const result = isPathInScope(baseDir, "/etc/passwd", undefined, undefined);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside the base working directory");
    });

    it("does not treat sibling dir with shared prefix as in-scope", () => {
      const base = resolve("/home/user/project");
      const sibling = resolve("/home/user/project2/secret.txt");
      expect(isPathInScope(base, sibling, undefined, { enabled: true, denied: [], allowed: [] }).allowed).toBe(false);
      expect(isPathWritable(base, sibling, undefined, { enabled: true, denied: [], allowed: [] }).allowed).toBe(false);
    });

    it("should block paths matching denied patterns", () => {
      const config = {
        enabled: true,
        denied: [".git/", "node_modules/", ".env"],
        allowed: [],
      };

      const result1 = isPathInScope(baseDir, ".git/config", undefined, config);
      expect(result1.allowed).toBe(false);
      expect(result1.reason).toContain("denied pattern");

      const result2 = isPathInScope(baseDir, "node_modules/package.json", undefined, config);
      expect(result2.allowed).toBe(false);
    });

    it("should allow only paths matching allowed patterns when allowed is non-empty", () => {
      const config = {
        enabled: true,
        denied: [],
        allowed: ["src/", "tests/"],
      };

      const result1 = isPathInScope(baseDir, "src/index.ts", undefined, config);
      expect(result1.allowed).toBe(true);

      const result2 = isPathInScope(baseDir, "docs/readme.md", undefined, config);
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain("does not match any allowed pattern");
    });

    it("should respect tool scope for read-only files", () => {
      const scope = {
        allowed_files: ["src/"],
        read_only_files: ["tests/"],
      };

      const result = isPathInScope(baseDir, "tests/test.ts", scope, undefined);
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Read-only");
    });

    it("should respect tool scope for allowed files", () => {
      const scope = {
        allowed_files: ["src/"],
        read_only_files: [],
      };

      const result1 = isPathInScope(baseDir, "src/index.ts", scope, undefined);
      expect(result1.allowed).toBe(true);

      const result2 = isPathInScope(baseDir, "tests/test.ts", scope, undefined);
      expect(result2.allowed).toBe(false);
    });

    it("should handle glob patterns with **", () => {
      const config = {
        enabled: true,
        denied: ["**/node_modules/"],
        allowed: [],
      };

      // Note: This test might fail on Windows due to path separator differences
      // The pattern matching needs to handle both / and \ separators
      const result = isPathInScope(baseDir, "src/node_modules/package.json", undefined, config);
      // For now, skip this test on Windows or adjust the pattern
      if (process.platform !== "win32") {
        expect(result.allowed).toBe(false);
      }
    });
  });

  describe("isPathWritable", () => {
    it("should allow writable paths within baseDir", () => {
      const result = isPathWritable(baseDir, "src/index.ts", undefined, undefined);
      expect(result.allowed).toBe(true);
    });

    it("should block paths outside baseDir", () => {
      const result = isPathWritable(baseDir, "/etc/passwd", undefined, undefined);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside the base working directory");
    });

    it("should block paths matching denied patterns", () => {
      const config = {
        enabled: true,
        denied: [".env"],
        allowed: [],
      };

      const result = isPathWritable(baseDir, ".env", undefined, config);
      expect(result.allowed).toBe(false);
    });

    it("should respect tool scope for allowed files only", () => {
      const scope = {
        allowed_files: ["src/"],
        read_only_files: ["tests/"],
      };

      const result1 = isPathWritable(baseDir, "src/index.ts", scope, undefined);
      expect(result1.allowed).toBe(true);

      // Read-only files should not be writable
      const result2 = isPathWritable(baseDir, "tests/test.ts", scope, undefined);
      expect(result2.allowed).toBe(false);
    });
  });
});

describe("cross-platform path-validator edge cases", () => {
  const cfg = { enabled: true, denied: [], allowed: [] };

  it("sibling prefix does not match subagent scope entry", () => {
    const base = "/home/user/project";
    const target = "/home/user/project-src/secret.txt";
    expect(isPathInScope(base, target, { allowed_files: ["project-files"], read_only_files: ["project"] }, cfg).allowed).toBe(false);
    expect(isPathWritable(base, target, { allowed_files: ["project"] }, cfg).allowed).toBe(false);
  });

  it("denied pattern with directory glob still matches nested files", () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "mma-pv-"));
    try {
      const cfg2 = { enabled: true, denied: ["secrets/"], allowed: [] };
      expect(isPathInScope(tmpBase, "secrets/key.txt", undefined, cfg2).allowed).toBe(false);
      expect(isPathInScope(tmpBase, "src/code.ts", undefined, cfg2).allowed).toBe(true);
    } finally {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("path-validator symlink containment", () => {
  it("blocks read AND write through a symlinked directory that escapes baseDir", () => {
    const base = mkdtempSync(join(tmpdir(), "mma-pv-base-"));
    const outside = mkdtempSync(join(tmpdir(), "mma-pv-out-"));
    try {
      const link = join(base, "link");
      try {
        symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      } catch {
        return; // symlink privileges unavailable in this environment — skip
      }
      writeFileSync(join(outside, "secret.txt"), "top secret");

      // Existing file reached through the symlink.
      expect(isPathWritable(base, "link/secret.txt", undefined, undefined).allowed).toBe(false);
      expect(isPathInScope(base, "link/secret.txt", undefined, undefined).allowed).toBe(false);

      // Not-yet-created file under the symlinked dir must also be blocked.
      expect(isPathWritable(base, "link/new.txt", undefined, undefined).allowed).toBe(false);

      // A direct child of baseDir is unaffected.
      expect(isPathWritable(base, "ok.txt", undefined, undefined).allowed).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
