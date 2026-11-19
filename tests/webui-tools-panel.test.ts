import { describe, expect, it } from "vitest";
import type { SessionRunner } from "../src/core/bootstrap/session-runner";
import type { ToolDefinition } from "../src/tools/types";
import type { ToolOverrideSet, WebToolInfo } from "../src/modules/webui/state";
import {
  applyToolOverrides,
  listTools,
  setToolOverride,
} from "../src/modules/webui/session/tools-view";

function tool(name: string, tags: string[], alwaysOn = false): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    parameters: { type: "object", properties: {} },
    tags,
    alwaysOn,
    handler: async () => ({ success: true, output: "" }),
  };
}

function runner(activeTags: string[]): SessionRunner {
  const tools = [tool("read_file", ["file"], true), tool("web_search", ["research"]), tool("remember", ["memory"], true)];
  const registry = {
    getAll: () => tools,
    get: (name: string) => tools.find((t) => t.name === name),
  };
  return {
    toolCtx: { activeToolTags: activeTags },
    registry,
  } as unknown as SessionRunner;
}

function stateWith(r: SessionRunner | undefined, overrides: Map<string, ToolOverrideSet>) {
  return {
    pool: { getRunner: () => r },
    toolOverrides: overrides,
    toolCatalog: (): WebToolInfo[] => [],
    config: { tools: { defaultTags: ["file"] } },
  };
}

describe("web tools panel", () => {
  it("computes the base set from the runner's active tags", () => {
    const r = runner(["file", "code"]);
    const tools = listTools(stateWith(r, new Map()), "s1");
    expect(tools.find((t) => t.name === "read_file")?.enabled).toBe(true);
    expect(tools.find((t) => t.name === "web_search")?.enabled).toBe(false);
    expect(tools.find((t) => t.name === "remember")?.enabled).toBe(true);
  });

  it("force-enables a tool outside its tags and adds the tag to the runner", () => {
    const r = runner(["file"]);
    const map = new Map<string, ToolOverrideSet>();
    setToolOverride(stateWith(r, map), "s1", "web_search", true);

    const view = listTools(stateWith(r, map), "s1").find((t) => t.name === "web_search");
    expect(view?.enabled).toBe(true);
    expect(view?.override).toBe("on");
    expect(r.toolCtx.activeToolTags).toContain("research");
    expect(r.toolCtx.toolOverrides?.enabled).toContain("web_search");
  });

  it("force-disables even an alwaysOn tool", () => {
    const r = runner(["file"]);
    const map = new Map<string, ToolOverrideSet>();
    setToolOverride(stateWith(r, map), "s1", "read_file", false);

    const view = listTools(stateWith(r, map), "s1").find((t) => t.name === "read_file");
    expect(view?.enabled).toBe(false);
    expect(view?.override).toBe("off");
    expect(r.toolCtx.toolOverrides?.disabled).toContain("read_file");
  });

  it("applies stored overrides when a runner is created later", () => {
    const r = runner(["file"]);
    applyToolOverrides(r, { enabled: ["web_search"], disabled: [] });
    expect(r.toolCtx.toolOverrides?.enabled).toEqual(["web_search"]);
    expect(r.toolCtx.activeToolTags).toContain("research");
  });
});
