import { describe, expect, it } from "bun:test";
import { PluginManager } from "../../../src/modules/plugins/manager";
import type { AgentPlugin } from "../../../src/modules/plugins/types";

describe("PluginManager onAfterThink", () => {
  it("should call onAfterThink on all plugins", () => {
    const manager = new PluginManager();
    const calls: string[] = [];

    const plugin1: AgentPlugin = {
      name: "test1",
      onAfterThink: () => {
        calls.push("plugin1");
      },
    };

    const plugin2: AgentPlugin = {
      name: "test2",
      onAfterThink: () => {
        calls.push("plugin2");
      },
    };

    manager.register(plugin1);
    manager.register(plugin2);

    manager.runOnAfterThink({});

    expect(calls).toEqual(["plugin1", "plugin2"]);
  });
});
