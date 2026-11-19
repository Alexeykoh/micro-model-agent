/**
 * A1 (`TODO` §1.8): `allowed_files`/`read_only_files` принимают glob-формы.
 * Прежний матчер сравнивал префиксы, поэтому шаблон вида `src` + `/` + `**`
 * не сопоставлялся ни с одним путём и субагент не читал ни одного файла.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { isPathInScope, isPathWritable } from "../../src/modules/security/path-validator";

const BASE = resolve("/workspace");
const ENABLED = { enabled: true, denied: [], allowed: [] };

describe("скоуп субагента: glob-записи (A1)", () => {
  it("allowed_files: src/**/*.ts открывает доступ к .ts внутри src", () => {
    const scope = { allowed_files: ["src/**/*.ts"], read_only_files: [] };
    expect(isPathInScope(BASE, "src/a.ts", scope, ENABLED).allowed).toBe(true);
    expect(isPathInScope(BASE, "src/x/y.ts", scope, ENABLED).allowed).toBe(true);
    expect(isPathWritable(BASE, "src/x/y.ts", scope, ENABLED).allowed).toBe(true);
    expect(isPathInScope(BASE, "src/a.md", scope, ENABLED).allowed).toBe(false);
    expect(isPathInScope(BASE, "docs/a.ts", scope, ENABLED).allowed).toBe(false);
  });

  it("причина отказа называет состав скоупа (INV-S4)", () => {
    const scope = { allowed_files: ["src/**/*.ts"], read_only_files: [] };
    const res = isPathInScope(BASE, "docs/a.md", scope, ENABLED);
    expect(res.allowed).toBe(false);
    expect(res.reason).toContain("src/**/*.ts");
  });

  it("read_only_files: **/*.md даёт чтение, но не запись", () => {
    const scope = { allowed_files: [], read_only_files: ["**/*.md"] };
    const read = isPathInScope(BASE, "docs/a.md", scope, ENABLED);
    expect(read.allowed).toBe(true);
    expect(read.reason).toContain("Read-only");
    expect(isPathWritable(BASE, "docs/a.md", scope, ENABLED).allowed).toBe(false);
  });

  it("** = весь workspace, но джейл baseDir держится", () => {
    const scope = { allowed_files: ["**"], read_only_files: [] };
    expect(isPathInScope(BASE, "src/deep/a.ts", scope, ENABLED).allowed).toBe(true);
    const outside = isPathInScope(BASE, "/etc/passwd", scope, ENABLED);
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toContain("outside the base working directory");
  });

  it("glob-скоуп действует и при enabled:false", () => {
    const scope = { allowed_files: ["src/**"], read_only_files: [] };
    const disabled = { enabled: false, denied: [], allowed: [] };
    expect(isPathInScope(BASE, "src/a/b.ts", scope, disabled).allowed).toBe(true);
    expect(isPathInScope(BASE, "tests/a.ts", scope, disabled).allowed).toBe(false);
  });
});
