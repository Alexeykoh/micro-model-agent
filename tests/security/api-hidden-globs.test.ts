import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import type { DataPolicyConfig, EgressTarget } from "../../src/modules/security/data-policy/types";

const ctx: PolicyContext = {
  baseDir: "C:\\work\\proj",
  home: "C:\\Users\\alex",
  hostname: "DESKTOP-ABC123",
  username: "alex",
  env: { USERNAME: "alex" },
  workspaceRoots: [],
};

function project(
  text: string,
  config: DataPolicyConfig,
  target: EgressTarget,
): string {
  const guard = createGuard({ config, target, ctx });
  const out = guard.sanitizeChat([{ role: "user", content: text }]);
  return String((out.messages[0] as { content: string }).content);
}

const base: DataPolicyConfig = { ...DEFAULT_DATA_POLICY, pathMode: "prefix" };

describe("скрытые globы действуют и на текст (args/output), не только на файловые API", () => {
  it("apiHiddenGlobs маскирует путь целиком, а не только корень", () => {
    const cfg: DataPolicyConfig = { ...base, apiHiddenGlobs: ["secret/**"] };
    const out = project("see C:\\work\\proj\\secret\\a.txt now", cfg, {
      kind: "api",
      trusted: false,
    });
    expect(out).toContain("[PATH]");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("a.txt");
    expect(out).not.toContain("C:\\work\\proj");
  });

  it("обычный путь остаётся в режиме prefix (остаток сохраняется)", () => {
    const cfg: DataPolicyConfig = { ...base, apiHiddenGlobs: ["secret/**"] };
    const out = project("see C:\\work\\proj\\src\\a.txt now", cfg, {
      kind: "api",
      trusted: false,
    });
    expect(out).toContain("src");
    expect(out).not.toContain("C:\\work\\proj");
  });

  it("providerBlockGlobs маскирует весь путь для внешнего провайдера", () => {
    const cfg: DataPolicyConfig = { ...base, providerBlockGlobs: ["secret/**"] };
    const out = project("see C:\\work\\proj\\secret\\a.txt now", cfg, {
      kind: "provider",
      trusted: false,
      host: "api.example.com",
    });
    expect(out).toContain("[PATH]");
    expect(out).not.toContain("secret");
  });

  it("доверенный провайдер путь не трогает", () => {
    const cfg: DataPolicyConfig = { ...base, providerBlockGlobs: ["secret/**"] };
    const out = project("see C:\\work\\proj\\secret\\a.txt now", cfg, {
      kind: "provider",
      trusted: true,
      host: "localhost",
    });
    expect(out).toContain("C:\\work\\proj\\secret\\a.txt");
  });
});
