import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry";
import { buildStartupAuditBlocks } from "../../src/core/bootstrap/modules-prompt";
import type { PromptBlock } from "../../src/core/types";

function block(partial: Partial<PromptBlock> & { content: string }): PromptBlock {
  return {
    priority: "normal",
    essential: false,
    estimatedTokens: Math.ceil(partial.content.length / 4),
    ...partial,
  };
}

function stubInput() {
  const registry = new ToolRegistry();
  registry.register({
    name: "browser_open",
    description: "opens a page",
    parameters: { type: "object", properties: {} },
    tags: ["browser"],
    execute: async () => ({ success: true, output: "ok" }),
  } as never);
  return {
    config: {
      model: "test-model-x",
      contextWindow: 32768,
      contextBudget: { systemPrompt: 0.1 },
      plugins: { disabled: [] },
      tools: { defaultTags: [] },
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
    dir: "/tmp",
    baseDir: "/tmp",
    toolRegistry: registry,
    pluginManager: {
      runOnBuildPrompt: () => ["PLUGIN-HOOK-CONTENT"],
      getRecords: () => [{ name: "p", enabled: true, provides: { tools: ["ptool"] } }],
    },
    skillsModule: {
      getSystemPromptBlock: () => null,
      getPromptBlocks: () => [block({ content: "SKILL-CATALOG", label: "skills catalog" })],
    },
    indexerModule: {
      getSystemPromptBlock: () =>
        block({ content: "PROJECT-MAP", label: "project map", kind: "project-map" }),
    },
    toolCtx: { toolAllowlist: undefined },
    activeToolTags: [],
  } as never;
}

const sessionModule = {
  getSystemPromptBlock: () => block({ content: "SESSION-META-123", label: "session" }),
} as never;

describe("buildStartupAuditBlocks (B1: dry-run parity)", () => {
  it("contains the same sync set as the first Agent build", () => {
    const blocks = buildStartupAuditBlocks(stubInput(), sessionModule);
    const joined = blocks.map((b) => b.content).join("\n");
    // Dynamic: model identity, session meta, skills, map, hidden tools.
    expect(joined).toContain("test-model-x");
    expect(joined).toContain("SESSION-META-123");
    expect(joined).toContain("SKILL-CATALOG");
    expect(joined).toContain("PROJECT-MAP");
    expect(joined).toContain("Additional tools");
    // Capabilities block (plugins) + onBuildPrompt hook content.
    expect(joined).toContain("[PLUGIN CAPABILITIES]");
    expect(joined).toContain("PLUGIN-HOOK-CONTENT");
  });
});
