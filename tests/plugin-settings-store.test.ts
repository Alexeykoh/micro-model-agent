// Стор настроек плагинов: путь sidecar-файла, roundtrip, кэш, hasSettings.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPlugin } from "../src/modules/types";
import {
  PluginSettingsStore,
  settingsPathFor,
} from "../src/modules/plugins/settings-store";
import { buildRecord } from "../src/modules/plugins/records";

function plugin(patch: Partial<AgentPlugin> & { name: string }): AgentPlugin {
  return { ...patch };
}

describe("settingsPathFor", () => {
  it("resolves a folder plugin to settings.json inside", () => {
    expect(settingsPathFor(join("/p", "my-plugin", "plugin.ts"))).toBe(
      join("/p", "my-plugin", "settings.json"),
    );
    expect(settingsPathFor(join("/p", "my-plugin", "index.js"))).toBe(
      join("/p", "my-plugin", "settings.json"),
    );
  });

  it("resolves a file plugin to a sidecar next to it", () => {
    expect(settingsPathFor(join("/p", "my-stats.ts"))).toBe(join("/p", "my-stats.settings.json"));
  });

  it("returns null without a path", () => {
    expect(settingsPathFor(undefined)).toBeNull();
  });
});

describe("PluginSettingsStore", () => {
  it("roundtrips values through the sidecar file with defaults underneath", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-plg-"));
    const entry = join(dir, "demo", "plugin.ts");
    mkdirSync(join(dir, "demo"), { recursive: true });
    writeFileSync(entry, "export default {}", "utf8");
    const plugins = new Map<string, AgentPlugin>([
      [
        "demo",
        plugin({
          name: "demo",
          path: entry,
          settingsSchema: [
            { key: "greeting", type: "string", default: "hi" },
            { key: "retries", type: "number", min: 1, max: 9 },
          ],
        }),
      ],
    ]);
    const store = new PluginSettingsStore((name) => plugins.get(name) ?? null);

    expect(store.getEffective("demo")).toEqual({ greeting: "hi" });
    const updated = store.update("demo", { retries: 3, greeting: "yo" });
    expect(updated).toMatchObject({ values: { greeting: "yo", retries: 3 }, hasSecrets: [] });
    expect(store.getEffective("demo")).toEqual({ greeting: "yo", retries: 3 });
  });

  it("returns null view and no_settings for plugins without schema", () => {
    const store = new PluginSettingsStore((name) =>
      name === "plain" ? plugin({ name: "plain", path: "/p/plain.ts" }) : null,
    );
    expect(store.getView("plain")).toBeNull();
    expect(store.update("plain", {})).toEqual({ error: "no_settings" });
    expect(store.getEffective("ghost")).toEqual({});
  });

  it("refuses builtin plugins even with a schema", () => {
    const store = new PluginSettingsStore((name) =>
      name === "core"
        ? plugin({ name: "core", isBuiltin: true, path: "/p/core.ts", settingsSchema: [] })
        : null,
    );
    expect(store.hasSettings(plugin({ name: "core", isBuiltin: true, path: "/p/core.ts" }))).toBe(
      false,
    );
    expect(store.getView("core")).toBeNull();
  });
});

describe("PluginRecord.hasSettings", () => {
  it("marks plugins with a schema and a path", () => {
    const withSettings = buildRecord(
      plugin({ name: "a", path: "/p/a.ts", settingsSchema: [{ key: "k", type: "string" }] }),
      { enabled: true },
    );
    expect(withSettings.hasSettings).toBe(true);
    const without = buildRecord(plugin({ name: "b", path: "/p/b.ts" }), { enabled: true });
    expect(without.hasSettings).toBe(false);
  });

  it("marks builtins with a schema (no path needed)", () => {
    const builtin = buildRecord(
      plugin({
        name: "notify",
        isBuiltin: true,
        settingsSchema: [{ key: "onSuccess", type: "boolean", default: true }],
      }),
      { enabled: true },
    );
    expect(builtin.hasSettings).toBe(true);
    const system = buildRecord(
      plugin({
        name: "execution",
        isBuiltin: true,
        system: true,
        settingsSchema: [{ key: "k", type: "string" }],
      }),
      { enabled: true },
    );
    expect(system.hasSettings).toBe(false);
  });
});

describe("builtin settings files", () => {
  it("roundtrips through <configDir>/plugin-settings/<name>.settings.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mma-cfg-"));
    const found: Record<string, AgentPlugin> = {
      notify: plugin({
        name: "notify",
        isBuiltin: true,
        settingsSchema: [{ key: "onSuccess", type: "boolean", default: true }],
      }),
    };
    const store = new PluginSettingsStore((name) => found[name] ?? null, dir);
    expect(store.getEffective("notify")).toEqual({ onSuccess: true });
    const updated = store.update("notify", { onSuccess: false });
    expect(updated).toMatchObject({ values: { onSuccess: false } });
    expect(store.getEffective("notify")).toEqual({ onSuccess: false });
    expect(
      JSON.parse(readFileSync(join(dir, "plugin-settings", "notify.settings.json"), "utf8")),
    ).toEqual({ onSuccess: false });
  });
});
