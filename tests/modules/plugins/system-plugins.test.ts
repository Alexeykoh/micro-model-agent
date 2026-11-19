// Guard: встроенные хуки модулей — не плагины. Их нельзя показывать как
// пользовательские и нельзя выключать (иначе «disable session» ломает сессии,
// хотя код модуля всё равно уже загружен).
import { describe, it, expect } from "vitest";
import { PluginManager } from "../../../src/modules/plugins/manager";
import type { AgentPlugin } from "../../../src/modules/types";

const systemPlugin = (name: string): AgentPlugin =>
  ({ name, version: "1.0.0", system: true, isBuiltin: true, priority: 10 }) as AgentPlugin;
const userPlugin = (name: string): AgentPlugin =>
  ({ name, version: "1.0.0", isBuiltin: true, priority: 10 }) as AgentPlugin;

describe("PluginManager: системные модули не отключаются", () => {
  it("records помечают system, выключение отклоняется", () => {
    const pm = new PluginManager();
    pm.register(systemPlugin("session"));
    pm.register(userPlugin("notify"));

    const records = pm.getRecords();
    expect(records.find((r) => r.name === "session")?.system).toBe(true);
    expect(records.find((r) => r.name === "notify")?.system).toBe(false);

    expect(pm.setEnabled("session", false)).toBe(false);
    expect(pm.isEnabled("session")).toBe(true);
    expect(pm.setEnabled("notify", false)).toBe(true);
    expect(pm.isEnabled("notify")).toBe(false);
  });

  it("setDisabledAll не пропускает системные имена", () => {
    const pm = new PluginManager();
    pm.register(systemPlugin("session"));
    pm.register(userPlugin("notify"));

    pm.setDisabledAll(["session", "notify"]);

    expect(pm.isEnabled("session")).toBe(true);
    expect(pm.isEnabled("notify")).toBe(false);
    expect(pm.getDisabled()).toEqual(["notify"]);
  });
});
