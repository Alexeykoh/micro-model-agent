// Guards for the Linux-only Omarchy theme source: `GET /api/os-theme` reads the
// active Omarchy theme from `~/.config/omarchy/current/theme/colors.toml`.
import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOsThemeInfo,
  parseOmarchyColors,
  readOmarchyTheme,
} from "../src/modules/webui/settings/os-theme.js";

const SEMANTIC = `mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"

background = "#1a1b26"
foreground = "#a9b1d6"

red = "#f7768e"
yellow = "#e0af68"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
bright_red = "#ff7a93"
`;

const LEGACY = `accent = "#7aa2f7"
background = "#1a1b26"
foreground = "#c0caf5"
color0 = "#15161e"
color1 = "#f7768e"
color4 = "#7aa2f7"
color7 = "#c0caf5"
color9 = "#ff7a93"
color15 = "#c0caf5"
`;

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const current = mkdtempSync(join(tmpdir(), "mma-omarchy-"));
  dirs.push(current);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(current, "theme"), { recursive: true });
    writeFileSync(join(current, name), body, "utf8");
  }
  return current;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Omarchy OS theme", () => {
  it("parses the semantic colors.toml", () => {
    const parsed = parseOmarchyColors(SEMANTIC);
    expect(parsed.mode).toBe("dark");
    expect(parsed.colors.background).toBe("#1a1b26");
    expect(parsed.colors.accent).toBe("#7aa2f7");
    expect(parsed.colors.bright_red).toBe("#ff7a93");
    expect(parsed.colors.selection).toBe("#292e42");
    expect(Object.keys(parsed.colors)).not.toContain("mode");
  });

  it("parses the legacy color0..color15 format", () => {
    const parsed = parseOmarchyColors(LEGACY);
    expect(parsed.colors.color0).toBe("#15161e");
    expect(parsed.colors.color9).toBe("#ff7a93");
  });

  it("reads the active theme name and colours", () => {
    const dir = fixture({
      "theme.name": "tokyo-night\n",
      "theme/colors.toml": SEMANTIC,
    });
    const theme = readOmarchyTheme(dir);
    expect(theme?.name).toBe("tokyo-night");
    expect(theme?.mode).toBe("dark");
    expect(theme?.colors.blue).toBe("#7aa2f7");
  });

  it("returns null when colors.toml is missing", () => {
    const dir = fixture({ "theme.name": "tokyo-night\n" });
    expect(readOmarchyTheme(dir)).toBeNull();
  });

  it("exposes Omarchy only on Linux", () => {
    const dir = fixture({ "theme/colors.toml": SEMANTIC });
    expect(getOsThemeInfo("linux", dir)).toMatchObject({
      available: true,
      omarchy: { colors: { accent: "#7aa2f7" } },
    });
    expect(getOsThemeInfo("win32", dir)).toEqual({ available: false, omarchy: null });
    expect(getOsThemeInfo("darwin", dir).omarchy).toBeNull();
  });
});
