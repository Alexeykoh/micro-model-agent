import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Completer } from "../../src/cli/completer";
import { FilePathProvider, SessionNameProvider } from "../../src/cli/completer-providers";

/**
 * Комплитер работает по токену ПОД КУРСОРОМ, понимает абсолютные пути и не
 * выдаёт простыню кандидатов (аудит §8.15, план
 * `2026-10-12-harness-module-audit-fixes`, W9/Task 9.4).
 */

describe("комплитер: токен под курсором", () => {
  it("completes the token under the cursor, not the last one", () => {
    const completer = new Completer();
    completer.registerProvider({
      name: "test",
      match: (ctx) => ctx.tokenIndex === 1,
      complete: (ctx) => [{ value: `${ctx.partial}-done` }],
    });
    // Курсор стоит на токене `ui.ver`, а в конце строки — другой токен.
    const [items, partial] = completer.complete("/config ui.ver other", 14);
    expect(partial).toBe("ui.ver");
    expect(items[0]?.value).toBe("ui.ver-done");
  });

  it("completes an absolute path from the filesystem root", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-abs-"));
    try {
      mkdirSync(join(dir, "usr", "share"), { recursive: true });
      writeFileSync(join(dir, "usr", "share", "note.txt"), "x");
      const provider = new FilePathProvider(dir);
      const ctx = {
        line: `cat ${dir}/usr/sh`,
        cursor: 0,
        tokens: ["cat", `${dir}/usr/sh`],
        partial: `${dir}/usr/sh`,
        tokenIndex: 1,
      };
      const items = provider.complete(ctx);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]?.value.endsWith("share/")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps long session lists", () => {
    const names = Array.from({ length: 30 }, (_, i) => `session-${i}`);
    const provider = new SessionNameProvider(() => names);
    const items = provider.complete({
      line: "/resume ",
      cursor: 8,
      tokens: ["/resume", ""],
      partial: "",
      tokenIndex: 1,
    });
    expect(items.length).toBe(21);
    expect(items[items.length - 1]?.value).toContain("10");
  });
});
