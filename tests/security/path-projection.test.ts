import { describe, expect, it } from "vitest";
import type { PolicyContext } from "../../src/modules/security/data-policy/context";
import { DEFAULT_DATA_POLICY } from "../../src/modules/security/data-policy/defaults";
import { createGuard } from "../../src/modules/security/data-policy/guard";
import type { DataPolicyConfig } from "../../src/modules/security/data-policy/types";

const ctx: PolicyContext = {
  baseDir: "/workspace",
  home: "/root",
  hostname: "dfdfd5800084",
  username: "root",
  platform: "linux",
  workspaceRoots: ["/config"],
};

function guard(overrides: Partial<DataPolicyConfig> = {}) {
  return createGuard({
    config: { ...DEFAULT_DATA_POLICY, ...overrides },
    target: { kind: "provider", trusted: false, host: "api.example.com" },
    ctx,
  });
}

function project(g: ReturnType<typeof guard>, text: string): string {
  const messages = g.sanitizeChat([{ role: "user", content: text }]).messages as Array<{
    content: string;
  }>;
  return String(messages[0]?.content ?? "");
}

function pathTokens(text: string): string[] {
  return text.match(/<PATH:[0-9a-f]+>/gi) ?? [];
}

describe("DLP path projection: workspace-relative", () => {
  it("вкладыш baseDir становится относительным, без токена", () => {
    const out = project(guard(), "open /workspace/src/a.ts");
    expect(out).toBe("open src/a.ts");
    expect(out).not.toContain("/workspace");
    expect(pathTokens(out)).toHaveLength(0);
  });

  it("корень workspace становится точкой", () => {
    const out = project(guard(), "Workspace: /workspace. CWD: /workspace");
    expect(out).toBe("Workspace: . CWD: .");
    expect(out).not.toContain("<PATH:");
  });

  it("похожий корень не матчится: /workspace-other остаётся как есть", () => {
    const out = project(guard(), "read /workspace-other/a.ts");
    expect(out).toBe("read /workspace-other/a.ts");
  });

  it("не-workspace корень остаётся токеном всего пути", () => {
    const g = guard();
    const out = project(g, "ls /config/config/provider.json");
    const tokens = pathTokens(out);
    expect(tokens).toHaveLength(1);
    expect(out).not.toContain("/config");
    expect(g.rehydrateArgs(tokens[0])).toBe("/config/config/provider.json");
  });

  it("подстрока /config внутри /app/src/config не режется", () => {
    const out = project(guard(), "read /app/src/config/env.ts");
    expect(out).toBe("read /app/src/config/env.ts");
  });
});

describe("DLP path projection: режимы и границы", () => {
  it("hidden-glob маскирует путь целиком", () => {
    const out = project(guard({ providerBlockGlobs: ["secret/**"] }), "see /workspace/secret/a.txt");
    expect(out).toBe("see [PATH]");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("a.txt");
  });

  it("pathMode=full токенизирует весь путь; голый токен самодостаточен", () => {
    const g = guard({ pathMode: "full" });
    const out = project(g, "open /workspace/src/a.ts");
    const tokens = pathTokens(out);
    expect(tokens).toHaveLength(1);
    expect(g.rehydrateArgs(tokens[0])).toBe("/workspace/src/a.ts");
  });

  it("pseudonymize=false маскирует весь путь, не оставляя хвоста", () => {
    const out = project(guard({ pseudonymize: false }), "open /workspace/src/a.ts");
    expect(out).toBe("open [PATH]");
    expect(out).not.toContain("src");
  });

  it("trusted=true не трогает пути", () => {
    const g = createGuard({
      config: { ...DEFAULT_DATA_POLICY },
      target: { kind: "provider", trusted: true, host: "localhost" },
      ctx,
    });
    expect(project(g, "open /workspace/src/a.ts")).toBe("open /workspace/src/a.ts");
  });
});
