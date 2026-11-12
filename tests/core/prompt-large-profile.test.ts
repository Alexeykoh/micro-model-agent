import { describe, it, expect } from "bun:test";
import { buildSystemInfo, resolvePromptProfile, LARGE_WINDOW_THRESHOLD } from "../../src/core/system-prompt";
import { fallbackPromptFacts } from "../../src/core/prompt-facts";
import { DEFAULTS } from "../../src/config/defaults";
import { setConfigValue } from "../../src/config/registry";
import type { PromptEnvironmentFacts } from "../../src/core/prompt-facts";

function facts(overrides: Partial<PromptEnvironmentFacts> = {}): PromptEnvironmentFacts {
  const base = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp/proj", "linux");
  return { ...base, ...overrides };
}

function prompt(overrides: Partial<PromptEnvironmentFacts> = {}, profile: "full" | "large" = "large"): string {
  return buildSystemInfo(structuredClone(DEFAULTS), "/tmp/proj", "linux", facts(overrides), profile);
}

describe("large prompt profile (L5)", () => {
  it("auto-classes by context window with a manual override", () => {
    const small = { contextWindow: 32768 } as never;
    const big = { contextWindow: 200000 } as never;
    expect(LARGE_WINDOW_THRESHOLD).toBe(128000);
    expect(resolvePromptProfile("auto", small)).toBe("full");
    expect(resolvePromptProfile("auto", big)).toBe("large");
    expect(resolvePromptProfile("auto", { contextWindow: 127999 } as never)).toBe("full");
    expect(resolvePromptProfile("auto", { contextWindow: 128000 } as never)).toBe("large");
    expect(resolvePromptProfile("full", big)).toBe("full");
    expect(resolvePromptProfile("large", small)).toBe("large");
  });

  it("adds rich context lines only in the large profile", () => {
    const rich = {
      platform: "linux",
      shell: "sh",
      mcp: { configured: ["gh"], connected: [] as string[] },
      project: { languages: ["typescript"] },
    } as never;
    const large = prompt(rich, "large");
    expect(large).toContain("Platform: linux (shell: sh).");
    expect(large).toContain("MCP servers configured: gh");
    expect(large).toContain("Project languages: typescript.");
    const full = prompt(rich, "full");
    expect(full).not.toContain("Platform: linux");
    expect(full).not.toContain("MCP servers configured");
    expect(full).not.toContain("Project languages:");
  });

  it("keeps every large line within the 120-char small-model canon", () => {
    const long = prompt(
      {
        platform: "linux",
        shell: "sh",
        mcp: { configured: ["a", "b", "c"], connected: [] as string[] },
        project: { languages: ["typescript", "python", "rust"] },
      } as never,
      "large",
    );
    expect(long.split("\n").filter((l) => l.length > 120)).toEqual([]);
  });

  it("registers promptProfile as a settable enum key defaulting to auto", () => {
    const cfg = structuredClone(DEFAULTS);
    expect(cfg.promptProfile).toBe("auto");
    expect(setConfigValue(cfg, "promptProfile", "large").ok).toBe(true);
    expect(cfg.promptProfile).toBe("large");
    expect(setConfigValue(cfg, "promptProfile", "banana").ok).toBe(false);
  });
});
