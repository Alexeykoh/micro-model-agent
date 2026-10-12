import { describe, it, expect, vi } from "vitest";
import { ModuleHost, ModuleHostError, type ModuleDef } from "../../src/core/module-host";
import { Logger } from "../../src/logger/app-logger";
import { OutputBus, type OutputEvent } from "../../src/output";
import type { AppConfig } from "../../src/config/types";

function makeHost(): { host: ModuleHost; bus: OutputBus } {
  const bus = new OutputBus();
  const logger = new Logger("info", "", bus);
  const host = new ModuleHost({} as unknown as AppConfig, logger, bus);
  return { host, bus };
}

describe("ModuleHost", () => {
  it("orders modules by requires (INV-5)", () => {
    const { host } = makeHost();
    host.register({ name: "c", requires: ["b"] });
    host.register({ name: "a" });
    host.register({ name: "b", requires: ["a"] });
    expect(host.initOrder()).toEqual(["a", "b", "c"]);
  });

  it("rejects an unknown dependency at setup", async () => {
    const { host } = makeHost();
    host.register({ name: "a", requires: ["ghost"] });
    await expect(host.setup()).rejects.toThrow(ModuleHostError);
  });

  it("rejects a requires cycle", async () => {
    const { host } = makeHost();
    host.register({ name: "a", requires: ["b"] });
    host.register({ name: "b", requires: ["a"] });
    await expect(host.setup()).rejects.toThrow(/cycle/);
  });

  it("fails boot when a critical module setup throws (INV-5)", async () => {
    const { host } = makeHost();
    host.register({
      name: "mcp",
      critical: true,
      setup: () => {
        throw new Error("boom");
      },
    });
    await expect(host.setup()).rejects.toThrow(/critical module "mcp"/);
  });

  it("keeps going and reports degraded when a non-critical module fails", async () => {
    const { host } = makeHost();
    const ran = vi.fn();
    host.register({
      name: "browser",
      critical: false,
      setup: () => {
        throw new Error("no chromium");
      },
    });
    host.register({ name: "lsp", setup: () => ran() });
    await host.setup();
    expect(ran).toHaveBeenCalledOnce();
    const health = Object.fromEntries(host.health().map((h) => [h.name, h.health]));
    expect(health.browser).toMatchObject({ status: "failed" });
    expect(health.browser.reason).toContain("no chromium");
    expect(health.lsp).toEqual({ status: "ok" });
  });

  it("times a hanging non-critical setup out (INV-8)", async () => {
    const { host } = makeHost();
    host.register({
      name: "slow",
      critical: false,
      setupTimeoutMs: 5,
      setup: () => new Promise<void>(() => {}),
    });
    await host.setup();
    expect(host.health()[0].health).toMatchObject({ status: "failed" });
    expect(host.health()[0].health.reason).toContain("timed out");
  });

  it("gives each module a child logger sourced module:<name> (INV-13)", async () => {
    const { host, bus } = makeHost();
    const events: OutputEvent[] = [];
    bus.subscribe((ev) => events.push(ev));
    host.register({ name: "indexer", setup: (ctx) => ctx.logger.warn("hi") });
    await host.setup();
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("module:indexer");
  });

  it("tears modules down in reverse init order (INV-7)", async () => {
    const { host } = makeHost();
    const torn: string[] = [];
    host.register({ name: "a", teardown: () => void torn.push("a") });
    host.register({ name: "b", requires: ["a"], teardown: () => void torn.push("b") });
    await host.setup();
    await host.dispose();
    expect(torn).toEqual(["b", "a"]);
  });

  it("collects tools, prompt blocks (owner-stamped) and hooks", () => {
    const { host } = makeHost();
    host.register({
      name: "indexer",
      tools: () => [
        { name: "t", description: "d", parameters: { type: "object", properties: {} }, handler: async () => ({ success: true, output: "" }) },
      ],
      promptBlocks: () => [{ content: "map", priority: "normal", essential: false, estimatedTokens: 5 }],
      hooks: () => ({ name: "h" }),
    });
    expect(host.collectTools().map((t) => t.name)).toEqual(["t"]);
    expect(host.collectPromptBlocks()[0].source).toBe("indexer");
    expect(host.collectHooks().map((p) => p.name)).toEqual(["h"]);
  });

  it("rejects a duplicate module name", () => {
    const { host } = makeHost();
    host.register({ name: "a" });
    expect(() => host.register({ name: "a" })).toThrow(/already registered/);
  });
});
