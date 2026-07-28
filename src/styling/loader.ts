import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ThemeConfig } from "./types.js";
import { createThemeEngine } from "./engine.js";
import type { ThemeEngine } from "./engine.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Р—Р°РіСЂСѓР·С‡РёРє Рё РјРµРЅРµРґР¶РµСЂ С‚РµРј.
 *
 * РЈРїСЂР°РІР»СЏРµС‚:
 * - Р’СЃС‚СЂРѕРµРЅРЅС‹РјРё С‚РµРјР°РјРё (light, dark)
 * - РџРѕР»СЊР·РѕРІР°С‚РµР»СЊСЃРєРёРјРё С‚РµРјР°РјРё РёР· ~/.mma/themes/
 * - РЈСЃС‚Р°РЅРѕРІРєРѕР№/СѓРґР°Р»РµРЅРёРµРј С‚РµРј РёР· URL
 * - РџРµСЂРµРєР»СЋС‡РµРЅРёРµРј Р°РєС‚РёРІРЅРѕР№ С‚РµРјС‹
 *
 * @module styling/loader
 */

const MMA_DIR = join(homedir(), ".mma");
const THEMES_DIR = join(MMA_DIR, "themes");

const BUILT_IN_THEMES: Record<string, ThemeConfig> = {
  light: {
    name: "light",
    colors: {
      prompt: "cyan",
      success: "green",
      error: "red",
      warning: "yellow",
      info: "blue",
      dim: "dim",
      toolName: "magenta",
      timing: "yellow",
      contextBar: "cyan",
      highlight: "bold",
      lineNumbers: "dim",
      filePath: "cyan",
      link: "underline",
      heading: "bold",
      symbolName: "yellow",
      symbolType: "dim",
      bracket: "dim",
      user: "yellow",
      assistant: "blue",
      subagent: "magenta",
      expert: "green",
    },
    icons: {
      success: "\u2713",
      failure: "\u2717",
      spinner: "\u231B",
      inProgress: "~",
      pending: " ",
      separator: "\u2501\u2501",
      arrow: "\u2192",
      barFill: "\u2588",
      barEmpty: "\u2591",
      check: "\u2713",
      cross: "\u2717",
      bullet: "\u251C\u2500\u2500",
      subBullet: "\u2502   \u251C\u2500\u2500",
      pipe: "\u2502",
    },
    format: { indent: "  ", indentSize: 2 },
  },
  dark: {
    name: "dark",
    colors: {
      prompt: "cyan",
      success: "green",
      error: "red",
      warning: "yellow",
      info: "cyan",
      dim: "dim",
      toolName: "magenta",
      timing: "yellow",
      contextBar: "cyan",
      highlight: "bold",
      lineNumbers: "dim",
      filePath: "cyan",
      link: "underline",
      heading: "bold",
      symbolName: "yellow",
      symbolType: "dim",
      bracket: "dim",
      user: "yellow",
      assistant: "cyan",
      subagent: "magenta",
      expert: "green",
    },
    icons: {
      success: "\u2713",
      failure: "\u2717",
      spinner: "\u231B",
      inProgress: "~",
      pending: " ",
      separator: "\u2501\u2501",
      arrow: "\u2192",
      barFill: "\u2588",
      barEmpty: "\u2591",
      check: "\u2713",
      cross: "\u2717",
      bullet: "\u251C\u2500\u2500",
      subBullet: "\u2502   \u251C\u2500\u2500",
      pipe: "\u2502",
    },
    format: { indent: "  ", indentSize: 2 },
  },
};

function loadJsonTheme(name: string): ThemeConfig | null {
  const path = join(THEMES_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function mergeTheme(
  base: ThemeConfig,
  overrides: Partial<ThemeConfig>,
): ThemeConfig {
  return {
    ...base,
    ...overrides,
    colors: { ...base.colors, ...overrides.colors },
    icons: { ...base.icons, ...overrides.icons },
    format: { ...base.format, ...overrides.format },
  };
}

export function loadThemeConfig(name?: string): ThemeConfig {
  const builtIn = BUILT_IN_THEMES[name || "light"] || BUILT_IN_THEMES.light;
  const custom = loadJsonTheme(name || "light");
  return custom ? mergeTheme(builtIn, custom) : builtIn;
}

export function loadTheme(name: string = "light"): ThemeEngine {
  return createThemeEngine(loadThemeConfig(name));
}

export function listThemes(): string[] {
  const builtIn = Object.keys(BUILT_IN_THEMES);
  let custom: string[] = [];
  try {
    custom = readdirSync(THEMES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  } catch {
    /* no custom themes dir */
  }
  return [...builtIn, ...custom];
}

export function installTheme(name: string, content: string): string {
  ensureThemeDir();
  const filePath = join(THEMES_DIR, `${name}.json`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export function removeTheme(name: string): boolean {
  const filePath = join(THEMES_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function ensureThemeDir(): void {
  if (!existsSync(THEMES_DIR)) {
    mkdirSync(THEMES_DIR, { recursive: true });
  }
}
