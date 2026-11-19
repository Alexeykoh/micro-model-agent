import { describe, expect, it } from "vitest";
import { projectText } from "../../src/modules/security/data-policy/project";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import { TokenMap } from "../../src/modules/security/data-policy/tokens";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  workspaceRoots: [],
};

const text = "open C:\\work\\proj\\src\\a.ts on DESKTOP-ABC123";

function policy(trusted = false) {
  return {
    config: { ...DEFAULT_DATA_POLICY },
    target: { kind: "provider" as const, trusted, host: "api.example.com" },
    ctx,
    map: new TokenMap(),
  };
}

describe("кеш проекции (projection-lifecycle)", () => {
  it("повторный вызов берёт готовый результат", () => {
    const p = policy();
    expect(projectText(text, p)).toBe(projectText(text, p));
  });

  it("доверие цели входит в ключ: тёплый кеш не маскирует локальному", () => {
    const p = policy(false);
    const masked = projectText(text, p);
    const trusted = projectText(text, { ...p, target: { ...p.target, trusted: true } });
    expect(masked.text).not.toContain("C:\\work\\proj");
    expect(trusted.text).toContain("C:\\work\\proj");
  });

  it("смена glob-списков не отдаёт результат старой политики", () => {
    const p = policy(false);
    const before = projectText(text, p);
    const after = projectText(text, {
      ...p,
      config: { ...p.config, providerBlockGlobs: ["src/**"] },
    });
    expect(before.text).not.toContain("C:\\work\\proj");
    expect(after.text).not.toContain("src\\a.ts");
  });
});
