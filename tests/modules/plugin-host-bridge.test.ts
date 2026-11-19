import { describe, it, expect } from "vitest";
import { PluginManager } from "../../src/modules/plugins/manager";
import type { HostBridge, TurnSummary } from "../../src/modules/types";

const bridge: HostBridge = {
  isBusy: () => false,
  submit: async () => ({ success: true }),
  interrupt: () => {},
};

describe("PluginManager host bridge", () => {
  it("merges hostBridge into hook context", () => {
    const mgr = new PluginManager();
    let seen: unknown;
    mgr.register({
      name: "spy",
      onSessionStart(ctx) {
        seen = ctx.hostBridge;
      },
    });
    mgr.setHostBridge(bridge);
    mgr.runOnSessionStart({ logger: console });
    expect(seen).toBe(bridge);
  });

  it("leaves ctx untouched when no bridge is set", () => {
    const mgr = new PluginManager();
    let keys: string[] = [];
    mgr.register({
      name: "spy",
      onSessionStart(ctx) {
        keys = Object.keys(ctx);
      },
    });
    mgr.runOnSessionStart({ logger: console });
    expect(keys).not.toContain("hostBridge");
  });

  it("does not overwrite caller-provided hostBridge", () => {
    const mine: HostBridge = { ...bridge, isBusy: () => true };
    const mgr = new PluginManager();
    let seen: unknown;
    mgr.register({
      name: "spy",
      onSessionStart(ctx) {
        seen = ctx.hostBridge;
      },
    });
    mgr.setHostBridge(bridge);
    mgr.runOnSessionStart({ hostBridge: mine });
    expect(seen).toBe(mine);
  });

  it("merges hostBridge into text/meta/tool dispatchers too", () => {
    const mgr = new PluginManager();
    const seen: unknown[] = [];
    mgr.register({
      name: "spy",
      onText(ctx) {
        seen.push(ctx.hostBridge);
      },
      onToolStart(ctx) {
        seen.push(ctx.hostBridge);
      },
    });
    mgr.setHostBridge(bridge);
    mgr.runOnText({}, "chunk");
    mgr.runOnToolStart({}, { id: "1", name: "bash", arguments: {} });
    expect(seen).toEqual([bridge, bridge]);
  });
});

describe("PluginManager runOnTurnEnd", () => {
  const summary: TurnSummary = {
    success: true,
    durationMs: 10,
    textLength: 1,
    toolCalls: 0,
  };

  it("dispatches onTurnEnd with summary and host bridge merged", () => {
    const mgr = new PluginManager();
    const seen: any[] = [];
    mgr.register({
      name: "collector",
      onTurnEnd(ctx, s) {
        seen.push([ctx.hostBridge ?? null, s]);
      },
    });
    mgr.setHostBridge(bridge);
    mgr.runOnTurnEnd({}, summary);
    expect(seen.length).toBe(1);
    expect(seen[0][0]).toBe(bridge);
    expect(seen[0][1]).toEqual(summary);
  });

  it("isolates plugin errors", () => {
    const mgr = new PluginManager();
    let reached = false;
    mgr.register({
      name: "bomb",
      onTurnEnd() {
        throw new Error("boom");
      },
    });
    mgr.register({
      name: "after",
      onTurnEnd() {
        reached = true;
      },
    });
    expect(() => mgr.runOnTurnEnd({}, summary)).not.toThrow();
    expect(reached).toBe(true);
  });

  it("is a no-op without plugins", () => {
    const mgr = new PluginManager();
    expect(() => mgr.runOnTurnEnd({}, summary)).not.toThrow();
  });
});
