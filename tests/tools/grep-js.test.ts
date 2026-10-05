// Phase 3: cross-platform grep fallback (zero-dep JS walker).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { searchWithJs, globToRegExp } from "../../src/tools/grep-js";

describe("searchWithJs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mma-grepjs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(rel: string, content: string) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }

  it("finds matching lines with path:line:text", () => {
    write("src/a.ts", "const x = 1;\nconst NEEDLE = 2;\n");
    write("src/b.ts", "nothing here\n");
    const out = searchWithJs("NEEDLE", dir, dir);
    expect(out).toContain("a.ts:2:const NEEDLE = 2;");
    expect(out).not.toContain("b.ts");
  });

  it("honors the include glob", () => {
    write("src/a.ts", "NEEDLE\n");
    write("src/a.md", "NEEDLE\n");
    const out = searchWithJs("NEEDLE", dir, dir, { include: "*.ts" });
    expect(out).toContain("a.ts");
    expect(out).not.toContain("a.md");
  });

  it("respects .gitignore", () => {
    write(".gitignore", "ignored/\n");
    write("ignored/secret.ts", "NEEDLE\n");
    write("src/a.ts", "NEEDLE\n");
    const out = searchWithJs("NEEDLE", dir, dir);
    expect(out).toContain("a.ts");
    expect(out).not.toContain("secret.ts");
  });

  it("skips binary files", () => {
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 78, 69]));
    write("src/a.ts", "NEEDLE\n");
    const out = searchWithJs("NEEDLE", dir, dir);
    expect(out).toContain("a.ts");
    expect(out).not.toContain("bin.dat");
  });

  it("returns empty string when nothing matches", () => {
    write("src/a.ts", "hello\n");
    expect(searchWithJs("ZZZ", dir, dir)).toBe("");
  });
});

describe("globToRegExp", () => {
  it("matches basename globs", () => {
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.md")).toBe(false);
  });
});
