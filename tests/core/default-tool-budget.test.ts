import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry";
import { registerAllTools } from "../../src/tools/index";
import { filterToolsByTags } from "../../src/tools/filter-tools";
import { estimateTokens } from "../../src/llm/token-counter";
import { DEFAULTS } from "../../src/config/defaults";
import { inferExtraToolTags } from "../../src/tools/auto-tags";
import { seedToolTags } from "../../src/tools/auto-tags";
import { createPlanToolDefinitions } from "../../src/modules/execution/plan-tool";
import { documentReadTool } from "../../src/modules/documents/tools/document-read";
import { withPluginMeta } from "../../src/modules/plugins/tool-defs";
import { createSetThinkingTool } from "../../src/tools/set-thinking";
import type { ToolDefinition } from "../../src/tools/types";

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  for (const def of createPlanToolDefinitions({} as never)) registry.register(def, "execution");
  registry.register(createSetThinkingTool({} as never, {} as never, () => 1), "core");
  registry.register(documentReadTool({} as never, undefined), "documents");
  registry.register(
    withPluginMeta("demo", "plugin__demo__ping", {
      name: "ping",
      description: "d",
      parameters: {},
      tags: [],
      handler: (async () => ({ output: "x" })) as never,
    } as ToolDefinition),
    "plugin:demo",
  );
  return registry;
}

describe("default tool visibility budget", () => {
  it("keeps a small essential set under defaultTags [file, code]", () => {
    const visible = filterToolsByTags(buildRegistry().getAll(), DEFAULTS.tools.defaultTags);
    const names = visible.map((t) => t.name);
    expect(visible.length).toBeLessThanOrEqual(16);
    const tokens = visible.reduce(
      (sum, t) => sum + estimateTokens(t.description + JSON.stringify(t.parameters)),
      0,
    );
    expect(tokens).toBeLessThanOrEqual(3000);
    for (const kept of [
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "list_dir",
      "bash",
      "git",
      "question",
      "approve",
      "enable_tools",
    ]) {
      expect(names, kept).toContain(kept);
    }
    for (const hidden of [
      "append_file",
      "restore_file",
      "plan",
      "plan_step",
      "todo",
      "verify",
      "set_thinking",
      "define_capability",
      "remember",
      "recall",
      "document_read",
      "plugin__demo__ping",
    ]) {
      expect(names, hidden).not.toContain(hidden);
    }
  });

  it("does not open web tools for a bare URL", () => {
    const message = "https://xoleague.duckdns.org выясни на чем хостится, что за провайдер /no_think";
    expect(inferExtraToolTags(message)).toEqual([]);
    const active = [...DEFAULTS.tools.defaultTags] as string[];
    expect(seedToolTags(active, message)).toEqual([]);
  });

  it("still exposes heavy tools through the documented on-demand tags", () => {
    const all = buildRegistry().getAll();
    const core = filterToolsByTags(all, ["core"]).map((t) => t.name);
    for (const name of ["plan", "plan_step", "todo", "verify", "set_thinking"]) {
      expect(core, name).toContain(name);
    }
    expect(filterToolsByTags(all, ["meta"]).map((t) => t.name)).toContain("define_capability");
    expect(filterToolsByTags(all, ["file-advanced"]).map((t) => t.name)).toContain("append_file");
    expect(filterToolsByTags(all, ["document"]).map((t) => t.name)).toContain("document_read");
    expect(filterToolsByTags(all, ["plugin:demo"]).map((t) => t.name)).toContain(
      "plugin__demo__ping",
    );
  });
});
