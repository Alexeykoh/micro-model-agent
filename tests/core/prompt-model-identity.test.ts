import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../../src/tools/registry";
import { collectDynamicPromptBlocks } from "../../src/core/bootstrap/modules-prompt";
import { buildRunnerDynamicBlocks } from "../../src/core/bootstrap/session-runner-scope";

function silentSkills() {
  return {
    getSystemPromptBlock: () => null,
    getPromptBlocks: () => [],
  };
}

function silentIndexer() {
  return { getSystemPromptBlock: () => null };
}

function silentSession() {
  return { getSystemPromptBlock: () => null };
}

function stubPlugins() {
  return { getRecords: () => [] };
}

describe("B5: dynamic model identity survives reconfigure", () => {
  it("main path reads the live config, not the bootstrap snapshot", () => {
    const blocks = collectDynamicPromptBlocks(
      {
        config: { model: "stale-model" },
        toolCtx: { toolAllowlist: undefined, config: { model: "live-model" } },
        pluginManager: stubPlugins(),
        skillsModule: silentSkills(),
        indexerModule: silentIndexer(),
        toolRegistry: new ToolRegistry(),
        activeToolTags: [],
      } as never,
      silentSession() as never,
    );
    const joined = blocks.map((b) => b.content).join("\n");
    expect(joined).toContain("live-model");
    expect(joined).not.toContain("stale-model");
  });

  it("runner path re-reads the model on every call", () => {
    const box = { model: "model-a" };
    const getDynamic = buildRunnerDynamicBlocks({
      getModel: () => box.model,
      skillsModule: silentSkills(),
      sessionModule: silentSession(),
      indexerModule: silentIndexer(),
      registry: new ToolRegistry(),
      runnerTags: [],
      toolAllowlist: undefined,
      pluginManager: stubPlugins() as never,
    });
    expect(getDynamic().map((b) => b.content).join("\n")).toContain("model-a");
    box.model = "model-b";
    const joined = getDynamic().map((b) => b.content).join("\n");
    expect(joined).toContain("model-b");
    expect(joined).not.toContain("model-a");
  });
});
