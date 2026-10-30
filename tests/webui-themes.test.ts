// Theme registry guard: adding an id to the picker without a stylesheet, a
// pre-paint whitelist entry or a label would render a dead card (or flash the
// wrong theme before boot).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_THEME_IDS, UI_THEMES } from "../src/modules/webui/assets/js/settings/themes.js";
import { resolveConfigKey } from "../src/config/registry";

const root = join(import.meta.dirname, "..");
const asset = (name: string): string =>
  readFileSync(join(root, "src/modules/webui/assets", name), "utf8");
const css = ["console.css", "groovebox.css", "themes.css"].map(asset).join("\n");
const html = asset("index.html");
const en = JSON.parse(readFileSync(join(root, "src/i18n/en.json"), "utf8")) as Record<
  string,
  string
>;
const ru = JSON.parse(readFileSync(join(root, "src/i18n/ru.json"), "utf8")) as Record<
  string,
  string
>;

describe("webui themes", () => {
  it("registers ten themes with three swatches each", () => {
    expect(UI_THEMES).toHaveLength(10);
    expect(new Set(UI_THEMES.map((t) => t.id)).size).toBe(10);
    for (const theme of UI_THEMES) expect(theme.colors).toHaveLength(3);
    expect(UI_THEMES.filter((t) => t.group === "seasonal")).toHaveLength(4);
    expect(UI_THEMES.filter((t) => t.group === "color")).toHaveLength(6);
  });

  it("every themed id has a body selector and a pre-paint entry", () => {
    for (const id of UI_THEME_IDS) {
      expect(css).toContain(`body.${id}`);
      expect(html).toContain(`"${id}"`);
    }
    expect(UI_THEME_IDS).not.toContain("flat");
  });

  it("every theme has en and ru labels and descriptions", () => {
    for (const theme of UI_THEMES) {
      const base = `web.settings.theme.${theme.id}`;
      for (const dict of [en, ru]) {
        expect(dict[base]).toBeTruthy();
        expect(dict[`${base}.desc`]).toBeTruthy();
      }
    }
  });

  it("seasonal themes carry an emoji mascot accessory", () => {
    for (const id of ["winter", "spring", "summer", "autumn"]) {
      expect(css).toContain(`body.${id} .mdl::after`);
    }
    // No hand-drawn hats: they were the crooked part.
    expect(css).not.toMatch(/body\.(winter|spring|summer|autumn) \.mdl::before/);
  });

  it("config registry lists exactly the picker themes (INV-T4)", () => {
    const themeDef = resolveConfigKey("ui.theme");
    const modeDef = resolveConfigKey("ui.themeMode");
    expect(themeDef?.enumValues).toEqual(UI_THEMES.map((t) => t.id));
    expect(modeDef?.enumValues).toEqual(["dark", "light", "auto"]);
    // Тема — серверная настройка без reconfigure: её пишут и во время хода.
    expect(themeDef?.effects).toEqual([]);
    expect(modeDef?.effects).toEqual([]);
  });
});
