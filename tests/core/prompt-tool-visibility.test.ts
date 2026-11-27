import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isExplicitLargeProfile } from "../../src/core/system-prompt-render";
import { resolvePromptProfile } from "../../src/core/system-prompt";
import { resolveToolVisibility } from "../../src/core/bootstrap/tool-visibility";
import { buildHiddenToolsBlock } from "../../src/tools/hidden-tools-block";
import type { ToolDefinition } from "../../src/tools/types";
import { DEFAULTS } from "../../src/config/defaults";
import { IndexerModule } from "../../src/modules/indexer";

const auto131k = { ...structuredClone(DEFAULTS), promptProfile: "auto", contextWindow: 131072 } as never;
const large131k = { ...structuredClone(DEFAULTS), promptProfile: "large", contextWindow: 131072 } as never;
const manualWide131k = {
  ...structuredClone(DEFAULTS),
  promptProfile: "auto",
  contextWindow: 131072,
  tools: { ...structuredClone(DEFAULTS.tools), enableOnDemand: false },
} as never;

function tool(name: string, tags: string[]): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    parameters: { type: "object", properties: {} },
    tags,
    handler: async () => ({ success: true, output: "" }),
  } as never;
}

describe("tool visibility profile", () => {
  it("auto на 131K остаётся узким, явный large — широкий", () => {
    expect(resolvePromptProfile("auto", auto131k)).toBe("large"); // текст промпта не меняем
    expect(isExplicitLargeProfile(auto131k)).toBe(false);
    expect(isExplicitLargeProfile(large131k)).toBe(true);
  });

  it("узкий auto при 131K, широкий только при явном large или enableOnDemand:false", () => {
    const narrow = resolveToolVisibility(auto131k);
    expect(narrow.enableOnDemand).toBe(true);
    expect(narrow.activeToolTags).toEqual([...DEFAULTS.tools.defaultTags]);

    const byProfile = resolveToolVisibility(large131k);
    expect(byProfile.enableOnDemand).toBe(false);
    expect(byProfile.activeToolTags).toEqual([]);

    const byConfig = resolveToolVisibility(manualWide131k);
    expect(byConfig.enableOnDemand).toBe(false);
    expect(byConfig.activeToolTags).toEqual([]);
  });

  it("hidden-tools блок перечисляет скрытые тулы только при узких тегах", () => {
    const tools = [tool("read_file", ["file"]), tool("web_search", ["web"])];
    const narrow = resolveToolVisibility(auto131k).activeToolTags;
    const block = buildHiddenToolsBlock(tools, narrow);
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain("web_search");
    expect(buildHiddenToolsBlock(tools, [])).toBe("");
  });

  it("stub-режим карты короткий и помечен kind=project-map", () => {
    const mod = new IndexerModule({ baseDir: process.cwd(), cacheDir: "<tmp>", promptMapMode: "stub" });
    const block = mod.getSystemPromptBlock();
    expect(block?.kind).toBe("project-map");
    expect((block?.content.length ?? 0) < 400).toBe(true);
    expect(block?.content).toContain("project_map");
  });

  it("session-phase берёт видимость из чистого seam, а не из resolvePromptProfile", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const phaseFile = "session-phase.ts";
    const src = readFileSync(join(root, "src", "core", "bootstrap", phaseFile), "utf-8");
    expect(src).toContain("resolveToolVisibility(config)");
    expect(src).not.toContain("wideByDefault");
  });
});
