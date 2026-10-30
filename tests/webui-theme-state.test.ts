// Тема веб-UI как серверная настройка: чистые правила резолва и миграции.
// См. docs/specs/2026-10-30-webui-theme-persistence-design.md (INV-T1/T5).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_SKIN,
  THEME_SKIN_IDS,
  isThemeMode,
  isThemeSkin,
  resolveThemeMode,
  resolveThemeSkin,
  themeModeMigration,
  themeSkinMigration,
} from "../src/modules/webui/assets/js/settings/theme-state.js";

describe("webui theme state", () => {
  it("resolves config → cache → default", () => {
    expect(resolveThemeMode("light", "dark")).toBe("light");
    expect(resolveThemeMode(undefined, "dark")).toBe("dark");
    expect(resolveThemeMode("banana", "banana")).toBe(DEFAULT_THEME_MODE);
    expect(resolveThemeMode(undefined, null)).toBe(DEFAULT_THEME_MODE);

    expect(resolveThemeSkin("paper", "neon")).toBe("paper");
    expect(resolveThemeSkin("nope", "neon")).toBe("neon");
    expect(resolveThemeSkin("nope", "nope")).toBe(DEFAULT_THEME_SKIN);
  });

  it("validates ids against the picker catalog", () => {
    expect(THEME_SKIN_IDS).toHaveLength(10);
    expect(isThemeSkin("flat")).toBe(true);
    expect(isThemeSkin("nope")).toBe(false);
    expect(isThemeMode("auto")).toBe(true);
    expect(isThemeMode("dim")).toBe(false);
  });

  it("migrates a pre-server cache only while the server holds the default (INV-T5)", () => {
    expect(themeModeMigration("auto", "light")).toBe("light");
    expect(themeModeMigration("dark", "light")).toBeNull();
    expect(themeModeMigration("auto", "auto")).toBeNull();
    expect(themeModeMigration("auto", null)).toBeNull();
    expect(themeModeMigration("auto", "dim")).toBeNull();

    expect(themeSkinMigration("console", "paper")).toBe("paper");
    expect(themeSkinMigration("neon", "paper")).toBeNull();
    expect(themeSkinMigration("console", "console")).toBeNull();
    expect(themeSkinMigration("console", "nope")).toBeNull();
  });
});
