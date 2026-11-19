// Живой вкл/выкл плагина: deny-list, диспатчеры, записи реестра, отказы загрузки.
import { describe, it, expect } from "vitest";
import { PluginManager } from "../src/modules/plugins/manager";
import type { AgentPlugin } from "../src/modules/types";
import { setConfigValue, setPluginGateApplier } from "../src/config/registry";
import { DEFAULTS } from "../src/config/defaults";
import type { AppConfig } from "../src/config/types";

/** Плагин, который считает вызовы каждого хука. */
function counting(name: string, calls: string[]): AgentPlugin {
  return {
    name,
    onSessionStart: () => void calls.push(`${name}:onSessionStart`),
    onBeforeThink: () => void calls.push(`${name}:onBeforeThink`),
    onTurnEnd: () => void calls.push(`${name}:onTurnEnd`),
    onToolEnd: () => void calls.push(`${name}:onToolEnd`),
    onBuildPrompt: () => null,
    onMeta: (ctx, chunk) => chunk,
  };
}

describe("plugins — enable/disable", () => {
  it("keeps a disabled plugin out of every dispatcher", () => {
    const calls: string[] = [];
    const manager = new PluginManager();
    manager.register(counting("a", calls));
    manager.register(counting("b", calls));

    manager.runOnSessionStart({});
    manager.runOnBeforeThink({});
    manager.runOnTurnEnd({} as never, {} as never);
    expect(calls).toContain("a:onSessionStart");
    expect(calls).toContain("b:onSessionStart");

    calls.length = 0;
    expect(manager.setEnabled("b", false)).toBe(true);
    manager.runOnSessionStart({});
    manager.runOnBeforeThink({});
    expect(calls).toEqual(["a:onSessionStart", "a:onBeforeThink"]);
  });

  it("a disabled plugin no longer blocks a tool call", async () => {
    const manager = new PluginManager();
    manager.register({
      name: "guard",
      onBeforeTool: () => false,
    });
    const call = { id: "1", name: "bash", arguments: {} };
    expect(await manager.runOnBeforeTool({}, call)).toBe(false);
    manager.setEnabled("guard", false);
    expect(await manager.runOnBeforeTool({}, call)).toBe(true);
  });

  it("a disabled plugin no longer transforms text/meta", () => {
    const manager = new PluginManager();
    manager.register({ name: "shout", onText: () => "LOUD" });
    expect(manager.runOnText({}, "hi")).toBe("LOUD");
    manager.setEnabled("shout", false);
    expect(manager.runOnText({}, "hi")).toBe("hi");
  });

  it("a disabled plugin drops out of getAllPlugins (the executor view)", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    expect(manager.getAllPlugins().map((p) => p.name)).toEqual(["a"]);
    manager.setEnabled("a", false);
    expect(manager.getAllPlugins()).toEqual([]);
  });

  it("stays disabled in getRecords but remains visible", () => {
    const manager = new PluginManager();
    manager.register({ name: "a", version: "1.0.0" });
    manager.setEnabled("a", false);
    const records = manager.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].enabled).toBe(false);
    expect(records[0].name).toBe("a");
  });

  it("re-enabling restores dispatch and record state", () => {
    const calls: string[] = [];
    const manager = new PluginManager();
    manager.register(counting("a", calls));
    manager.setEnabled("a", false);
    manager.runOnSessionStart({});
    expect(calls).toEqual([]);

    manager.setEnabled("a", true);
    manager.runOnSessionStart({});
    expect(calls).toEqual(["a:onSessionStart"]);
    expect(manager.getRecords()[0].enabled).toBe(true);
  });

  it("toggling twice is idempotent", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    manager.setEnabled("a", false);
    manager.setEnabled("a", false);
    expect(manager.getDisabled()).toEqual(["a"]);
    manager.setEnabled("a", true);
    manager.setEnabled("a", true);
    expect(manager.getDisabled()).toEqual([]);
  });

  it("setEnabled on an unknown plugin returns false but remembers the disable", () => {
    const manager = new PluginManager();
    expect(manager.setEnabled("ghost", false)).toBe(false);
    expect(manager.getDisabled()).toEqual(["ghost"]);
    expect(manager.setEnabled("ghost", true)).toBe(false);
    expect(manager.getDisabled()).toEqual([]);
  });

  it("a plugin registered after being denied starts switched off", () => {
    const calls: string[] = [];
    const manager = new PluginManager();
    manager.setEnabled("late", false);
    manager.register(counting("late", calls));
    manager.runOnSessionStart({});
    expect(calls).toEqual([]);
    expect(manager.getRecords()[0].enabled).toBe(false);
  });

  it("setDisabledAll replaces the whole deny-list and keeps unknown names", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    manager.setDisabledAll(["a", "not-here"]);
    expect(manager.getDisabled()).toEqual(["a", "not-here"]);
    manager.setDisabledAll([]);
    expect(manager.getDisabled()).toEqual([]);
  });

  it("survives a plugin that throws while disabled", async () => {
    const manager = new PluginManager();
    manager.register({
      name: "boom",
      onBeforeTool: () => {
        throw new Error("x");
      },
    });
    manager.setEnabled("boom", false);
    expect(await manager.runOnBeforeTool({}, { id: "1", name: "bash", arguments: {} })).toBe(true);
  });
});

describe("plugins — getRecords + getFailures", () => {
  it("caches records and invalidates the cache on enable/disable", () => {
    const manager = new PluginManager();
    manager.register({ name: "a", version: "1.0.0" });
    const first = manager.getRecords();
    expect(manager.getRecords()).toEqual(first);
    manager.setEnabled("a", false);
    expect(manager.getRecords()[0].enabled).toBe(false);
  });

  it("hands out copies, so a caller cannot mutate the cache", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    const rec = manager.getRecords()[0];
    rec.name = "hacked";
    expect(manager.getRecords()[0].name).toBe("a");
  });

  it("refuses to register a plugin with an invalid name", () => {
    const manager = new PluginManager();
    const res = manager.register({ name: "Bad Name" } as AgentPlugin);
    expect(res.status).toBe("invalid");
    expect(manager.getRecords()).toHaveLength(0);
  });

  it("registers with warnings and surfaces them in the record", () => {
    const manager = new PluginManager();
    const res = manager.register({ name: "a", homepage: "nope" });
    expect(res.status).toBe("registered");
    expect(res.warnings?.length).toBe(1);
    expect(manager.getRecords()[0].warnings).toHaveLength(1);
  });

  it("records load failures with a one-line reason", () => {
    const manager = new PluginManager();
    manager.noteFailure("foo/plugin.ts", "/x/foo/plugin.ts", "Unexpected token '}'\n  at foo");
    const failures = manager.getFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("Unexpected token '}'");
    expect(failures[0].entry).toBe("foo/plugin.ts");
  });
});

describe("plugins — plugins.disabled через setConfigValue", () => {
  it("применяет deny-list к живому менеджеру", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    const config: AppConfig = structuredClone(DEFAULTS);
    config.plugins = { disabled: [] };
    setPluginGate(manager);

    expect(setConfigValue(config, "plugins.disabled", "a").ok).toBe(true);
    expect(manager.isEnabled("a")).toBe(false);
    expect(config.plugins?.disabled).toEqual(["a"]);
  });

  it("применяется и по алиасу списка с запятыми", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    manager.register({ name: "b" });
    const config: AppConfig = structuredClone(DEFAULTS);
    setPluginGate(manager);

    setConfigValue(config, "plugins.disabled", "a, b");
    expect(manager.getDisabled()).toEqual(["a", "b"]);
    expect(manager.getRecords().every((r) => !r.enabled)).toBe(true);
  });

  it("пустой список включает всё обратно", () => {
    const manager = new PluginManager();
    manager.register({ name: "a" });
    manager.setEnabled("a", false);
    const config: AppConfig = structuredClone(DEFAULTS);
    setPluginGate(manager);
    setConfigValue(config, "plugins.disabled", "");
    expect(manager.getDisabled()).toEqual([]);
  });

  it("неизвестное имя не отвергается (конфиг переносится между машинами)", () => {
    const manager = new PluginManager();
    const config: AppConfig = structuredClone(DEFAULTS);
    setPluginGate(manager);
    const res = setConfigValue(config, "plugins.disabled", "ghost");
    expect(res.ok).toBe(true);
    expect(manager.getDisabled()).toEqual(["ghost"]);
  });
});

/** Ставит шов конфиг → менеджер (bootstrap делает то же). */
function setPluginGate(manager: PluginManager): void {
  setPluginGateApplier((names) => manager.setDisabledAll(names));
}
