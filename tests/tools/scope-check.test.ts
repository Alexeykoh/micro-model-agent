import { describe, it, expect } from "vitest";
// Production path scope lives in the security module; `tools/scope-check.ts`
// was a dead duplicate (only this test imported it) and was removed.
import { isPathInScope, isPathWritable } from "../../src/modules/security/path-validator";

const BASE = "/workspace";

describe("isPathInScope", () => {
  it("fails closed when no config section is provided (D8)", () => {
    const result = isPathInScope(BASE, "src/file.ts");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("fail-closed");
  });

  it("allows within base dir when the section exists but is explicitly disabled", () => {
    const result = isPathInScope(BASE, "src/file.ts", undefined, { enabled: false, denied: [], allowed: [] });
    expect(result.allowed).toBe(true);
  });

  it("still honors a sub-agent scope without a config section", () => {
    const result = isPathInScope(BASE, "src/file.ts", { allowed_files: ["src"], read_only_files: [] });
    expect(result.allowed).toBe(true);
  });

  it("rejects paths outside base dir", () => {
    const result = isPathInScope(BASE, "/etc/passwd");
    expect(result.allowed).toBe(false);
  });

  it("allows paths within allowed_files", () => {
    const result = isPathInScope(BASE, "src/file.ts", {
      allowed_files: ["src"],
      read_only_files: [],
    });
    expect(result.allowed).toBe(true);
  });

  it("allows paths within read_only_files", () => {
    const result = isPathInScope(BASE, "docs/readme.md", {
      allowed_files: ["src"],
      read_only_files: ["docs"],
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects paths outside allowed scope", () => {
    const result = isPathInScope(BASE, "node_modules/pkg/index.js", {
      allowed_files: ["src"],
      read_only_files: ["docs"],
    });
    expect(result.allowed).toBe(false);
  });

  it("handles subpaths within allowed_files", () => {
    const result = isPathInScope(BASE, "src/deep/nested/file.ts", {
      allowed_files: ["src"],
      read_only_files: [],
    });
    expect(result.allowed).toBe(true);
  });

  it("works with Windows-style paths", () => {
    const result = isPathInScope("C:\\projects\\app", "src\\file.ts", {
      allowed_files: ["src"],
      read_only_files: [],
    });
    expect(result.allowed).toBe(true);
  });
});

describe("isPathWritable", () => {
  it("allows write to paths in allowed_files", () => {
    const result = isPathWritable(BASE, "src/new-file.ts", {
      allowed_files: ["src"],
      read_only_files: ["docs"],
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects write to read_only_files", () => {
    const result = isPathWritable(BASE, "docs/readme.md", {
      allowed_files: ["src"],
      read_only_files: ["docs"],
    });
    expect(result.allowed).toBe(false);
  });

  it("rejects write outside scope", () => {
    const result = isPathWritable(BASE, "package.json", {
      allowed_files: ["src"],
      read_only_files: [],
    });
    expect(result.allowed).toBe(false);
  });

  it("fails closed on write when no config section is provided (D8)", () => {
    const result = isPathWritable(BASE, "any/file.ts");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("fail-closed");
  });

  it("allows write without scope when the section exists but is disabled", () => {
    const result = isPathWritable(BASE, "any/file.ts", undefined, { enabled: false, denied: [], allowed: [] });
    expect(result.allowed).toBe(true);
  });
});

describe("cross-platform scope edge cases", () => {
  it("sibling directory sharing prefix does not match scope entry", () => {
    // entry "src" must not authorize "src-other/..."
    const result = isPathInScope("/workspace", "src-other/file.ts", {
      allowed_files: ["src"],
      read_only_files: [],
    });
    expect(result.allowed).toBe(false);
  });

  it("sibling directory sharing prefix does not pass baseDir containment", () => {
    const result = isPathInScope("/workspace", "/workspace2/file.ts");
    expect(result.allowed).toBe(false);
  });

  if (process.platform === "win32") {
    it("case-insensitive baseDir containment on Windows", () => {
      const result = isPathInScope("E:\\Proj", "SRC\\file.ts", {
        allowed_files: ["src"],
        read_only_files: [],
      });
      expect(result.allowed).toBe(true);
    });
  }
});
