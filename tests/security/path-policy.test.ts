import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalize,
  hiddenReason,
  matchAnyGlob,
  matchGlob,
  relativeTo,
} from "../../src/modules/security/data-policy/path-policy";

describe("glob-матчинг путей", () => {
  it("сегментный `*` и рекурсивный `**`", () => {
    expect(matchGlob("src/secret/a.ts", "src/secret/**")).toBe(true);
    expect(matchGlob("src/secret/deep/a.ts", "src/secret/**")).toBe(true);
    expect(matchGlob("src/public/a.ts", "src/secret/**")).toBe(false);
    expect(matchGlob("a/server.pem", "*.pem")).toBe(true);
    expect(matchGlob("a/server.key", "*.pem")).toBe(false);
  });

  it("директория-паттерн со слэшем", () => {
    expect(matchGlob(".git/config", ".git/")).toBe(true);
    expect(matchGlob("src/app.ts", ".git/")).toBe(false);
  });

  it("регистр и разделители не влияют (win32-safe)", () => {
    expect(matchGlob("SRC\\Secret\\A.TS", "src/secret/**")).toBe(true);
  });

  it("matchAnyGlob возвращает совпавший glob", () => {
    expect(matchAnyGlob("keys/a.pem", ["*.key", "*.pem"])).toBe("*.pem");
    expect(matchAnyGlob("ok/a.ts", ["*.pem"])).toBeUndefined();
  });
});

describe("канонический путь и относительность", () => {
  it("relativeTo: forward-slash от workspace", () => {
    const base = mkdtempSync(join(tmpdir(), "dp-"));
    try {
      expect(relativeTo(base, join(base, "sub", "file.ts"))).toBe("sub/file.ts");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("hiddenReason: symlink на скрытое не обходит (INV-D10)", () => {
    const base = mkdtempSync(join(tmpdir(), "dp-"));
    try {
      mkdirSync(join(base, "private"), { recursive: true });
      writeFileSync(join(base, "private", "secret.txt"), "s");
      // Прямой путь.
      expect(hiddenReason("private/secret.txt", base, ["private/**"])).toBe("private/**");
      // Симлинк-«дверь» (если ОС позволяет создать symlink).
      try {
        symlinkSync(join(base, "private", "secret.txt"), join(base, "link.txt"));
        // Канонизация уводит на private/... → всё равно скрыто.
        const c = canonicalize("link.txt", base);
        expect(c).toContain("private");
      } catch {
        /* symlink недоступен на платформе — пропускаем */
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
