import { describe, it, expect } from "vitest";
import { assembleDynamicPromptBlocks } from "../../src/core/prompt-assembler";
import { buildRunnerDynamicBlocks } from "../../src/core/bootstrap/session-runner-scope";
import { ToolRegistry } from "../../src/tools/registry";
import { PluginManager } from "../../src/modules/plugins/manager";
import { pluginCapabilitiesBlock } from "../../src/modules/plugins/capabilities-block";
import type { PromptBlock } from "../../src/core/types";

function block(content: string): PromptBlock {
  return { content, priority: "normal", essential: false, estimatedTokens: 1 };
}

/** W1.5 (INV-16): сборка промпта — одна функция; раннер делегирует ей. */
describe("PromptAssembler (W1.5, INV-16)", () => {
  const skills = { getSystemPromptBlock: () => block("skills") };
  const session = { getSystemPromptBlock: () => block("session") };
  const indexer = { getSystemPromptBlock: () => block("map") };

  it("orders blocks: model → skills → session → map → capabilities → hidden", () => {
    const registry = new ToolRegistry();
    const order = assembleDynamicPromptBlocks({
      model: "m",
      skillsModule: skills,
      sessionModule: session,
      indexerModule: indexer,
      registry,
      activeTags: [],
      capabilitiesBlock: { ...block("caps"), source: "plugins" },
    }).map((b) => b.source ?? "core");
    // Скрытых тулов нет (реестр пуст) — блок не создаётся.
    expect(order).toEqual(["core", "skills", "session", "indexer", "plugins"]);
  });

  it("stamps block owners and omits the hidden-tools block under an allowlist", () => {
    const registry = new ToolRegistry();
    const blocks = assembleDynamicPromptBlocks({
      model: "m",
      skillsModule: skills,
      sessionModule: session,
      indexerModule: indexer,
      registry,
      activeTags: ["file"],
      toolAllowlist: ["read_file"],
    });
    const sources = blocks.map((b) => b.source);
    expect(sources).toContain("skills");
    expect(sources).toContain("session");
    expect(sources).toContain("indexer");
    // allowlist → блок скрытых тулов не показываем.
    expect(blocks.some((b) => b.label === "hidden tools")).toBe(false);
  });

  it("runner delegates to the shared assembler (no second copy of the structure)", () => {
    const registry = new ToolRegistry();
    const pm = new PluginManager();
    const config = { model: "m" } as never;

    const runnerBlocks = buildRunnerDynamicBlocks({
      config,
      skillsModule: skills,
      sessionModule: session,
      indexerModule: indexer,
      registry,
      runnerTags: [],
      pluginManager: pm,
    })();

    const expected = assembleDynamicPromptBlocks({
      model: "m",
      skillsModule: skills,
      sessionModule: session,
      indexerModule: indexer,
      registry,
      activeTags: [],
      capabilitiesBlock: (() => {
        const caps = pluginCapabilitiesBlock({ pluginManager: pm, pluginsVisible: true });
        return caps ? { source: "plugins", ...caps } : null;
      })(),
    });

    expect(runnerBlocks.map((b) => b.source)).toEqual(expected.map((b) => b.source));
  });
});
