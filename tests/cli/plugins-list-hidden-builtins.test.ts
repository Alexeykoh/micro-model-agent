// Guard: `mma plugins list` не должен говорить «Плагины не загружены», когда
// загружены встроенные (они скрыты из листинга по умолчанию).
//
// Регресс из стресс-теста (волна 18): в одном и том же конфиге
// `mma plugins list` печатал «Плагины не загружены», а `mma doctor` —
// `Plugins [ok] loaded: 10 active / 10 total`, веб-панель — те же 10.
import { describe, it, expect } from "vitest";
import { pluginListLines } from "../../src/cli/plugin-commands";
import type { PluginRecord } from "../../src/modules/plugins/records";

function record(name: string, builtin: boolean): PluginRecord {
  return {
    name,
    builtin,
    enabled: true,
    version: "1.0.0",
    source: builtin ? "builtin" : "file",
    author: "",
    description: "",
    permissions: [],
    provides: { tools: [], hooks: [] },
    warnings: [],
    path: "",
  } as unknown as PluginRecord;
}

const builtins = Array.from({ length: 10 }, (_, i) => record(`builtin-${i}`, true));

describe("mma plugins list: скрытые встроенные", () => {
  it("«Плагины не загружены» не печатается, если есть встроенные", () => {
    const lines = pluginListLines(builtins, [], false, "0.15.0");

    expect(lines).toHaveLength(1);
    // Ключ «Сторонних плагинов нет.» — правда; «Плагины не загружены» — нет.
    expect(lines[0]).not.toContain("cli.plugins.none\b");
    expect(lines.join("\n")).not.toMatch(/(Плагины не загружены|No plugins loaded)/);
  });

  it("с --all печатает встроенные", () => {
    const lines = pluginListLines(builtins, [], true, "0.15.0");

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("builtin-0");
    expect(lines.join("\n")).toContain("10");
  });

  it("один внешний плагин: строка плагина + подсказка про сторонние", () => {
    const lines = pluginListLines([record("my-plugin", false), ...builtins], [], false, "0.15.0");

    expect(lines.join("\n")).toContain("my-plugin");
    expect(lines.join("\n")).not.toContain("builtin-0");
  });

  it("совсем пустой конфиг: честное «плагинов нет»", () => {
    const lines = pluginListLines([], [], false, "0.15.0");

    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/(Плагины не загружены|No plugins loaded)/);
  });

  it("падения загрузки печатаются даже без загруженных плагинов", () => {
    const lines = pluginListLines(
      [],
      [{ entry: "broken", path: "C:/x/broken.js", message: "boom" } as never],
      false,
      "0.15.0",
    );

    expect(lines.join("\n")).toContain("boom");
  });
});
