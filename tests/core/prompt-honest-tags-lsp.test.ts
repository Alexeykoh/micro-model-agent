import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry";
import { filterBlocksForTags } from "../../src/core/prompt-builder";
import { collectPromptFacts, fallbackPromptFacts } from "../../src/core/prompt-facts";
import { buildSystemInfo } from "../../src/core/system-prompt";
import { DEFAULTS } from "../../src/config/defaults";
import type { PromptBlock } from "../../src/core/types";

function tagBlock(content: string, requiresTags?: string[]): PromptBlock {
  return { content, priority: "normal", essential: false, estimatedTokens: 1, requiresTags };
}

function registryWithBrowser(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: "read_file",
      description: "reads",
      parameters: { type: "object", properties: {} },
      tags: ["file"],
      execute: async () => ({ success: true, output: "ok" }),
    } as never,
    "core",
  );
  registry.register(
    {
      name: "browser_open",
      description: "opens",
      parameters: { type: "object", properties: {} },
      tags: ["browser"],
      execute: async () => ({ success: true, output: "ok" }),
    } as never,
    "browser",
  );
  return registry;
}

describe("B12: requiresTags gated by actually visible tools", () => {
  it("derives visible tags from the real schema, allowlist-aware", () => {
    const registry = registryWithBrowser();
    // Narrowed, no allowlist: only file tag visible.
    expect([...registry.visibleTagsOf(["file"])]).toEqual(["file"]);
    // Browser active but allowlisted out: browser tag not visible.
    const gated = registry.visibleTagsOf(["file", "browser"], ["read_file"]);
    expect(gated.has("browser")).toBe(false);
    expect(gated.has("file")).toBe(true);
  });

  it("drops a requiresTags block whose tools were allowlisted out", () => {
    const browser = tagBlock("browser instructions", ["browser"]);
    const visible = new Set(["file"]);
    expect(filterBlocksForTags([browser], ["file", "browser"], visible)).toEqual([]);
  });

  it("keeps the block when its tag is both active and visible", () => {
    const browser = tagBlock("browser instructions", ["browser"]);
    expect(filterBlocksForTags([browser], ["browser"], new Set(["browser"]))).toEqual([browser]);
  });

  it("keeps legacy behavior without the visible set", () => {
    const browser = tagBlock("browser instructions", ["browser"]);
    expect(filterBlocksForTags([browser], ["browser"])).toEqual([browser]);
    expect(filterBlocksForTags([browser], [])).toEqual([browser]);
    expect(filterBlocksForTags([browser], undefined)).toEqual([browser]);
  });
});

describe("B6: honest LSP facts", () => {
  const envReport = {
    os: { platform: "linux" },
    runtime: { runtime: "bun" },
    tools: { bun: "1.0", git: "missing", python: "missing" },
  } as never;

  it("does not claim a server before LSP starts", () => {
    const config = { ...structuredClone(DEFAULTS), lsp: { enabled: true } } as never;
    const facts = collectPromptFacts({ config, baseDir: "/tmp", envReport, activeToolTags: [] });
    expect(facts.lsp.enabled).toBe(true);
    expect(facts.lsp.hasServer).toBe(false);
  });

  it("fallback facts do not claim a server either", () => {
    const facts = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp", "linux");
    expect(facts.lsp.hasServer).toBe(false);
  });

  it("prefers the project check until a server is confirmed", () => {
    const base = fallbackPromptFacts(structuredClone(DEFAULTS), "/tmp", "linux");
    const unconfirmed = buildSystemInfo(
      structuredClone(DEFAULTS),
      "/tmp",
      "linux",
      { ...base, lsp: { enabled: true, hasServer: false } },
    );
    expect(unconfirmed).toContain("lsp_check");
    expect(unconfirmed).toContain("not confirmed");
    const confirmed = buildSystemInfo(
      structuredClone(DEFAULTS),
      "/tmp",
      "linux",
      { ...base, lsp: { enabled: true, hasServer: true } },
    );
    expect(confirmed).toContain("lsp_check");
    expect(confirmed).not.toContain("not confirmed");
  });
});
