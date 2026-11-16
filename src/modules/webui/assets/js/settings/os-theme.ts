// Runtime palette for the `omarchy` theme. The backend reads the active
// Omarchy Linux theme (`~/.config/omarchy/current/theme/colors.toml`) and this
// module turns its ANSI/semantic colours into the web UI token set. The static
// `omarchy.css` only covers the pre-fetch flash; once `/api/os-theme` answers,
// the derived values are set inline on `<body>` (highest specificity).
//
// Omarchy colours are optional: an unknown key falls back to a Tokyo Night-ish
// default, so the theme is still usable on Linux without Omarchy installed.

export interface OmarchyThemeInfo {
  name: string | null;
  mode: "dark" | "light";
  colors: Record<string, string>;
}

export interface OsThemeInfo {
  /** `true` only on Linux; a boolean so the DLP filter cannot redact it. */
  available: boolean;
  omarchy: OmarchyThemeInfo | null;
}

/** Token properties set by the runtime palette (cleared when leaving the skin). */
const TOKEN_KEYS = [
  "--bg",
  "--fg",
  "--panel",
  "--sb-bg",
  "--stab-bg",
  "--surface",
  "--input-surface",
  "--inp-bg",
  "--inp-border",
  "--inp-focus",
  "--input-shadow",
  "--border",
  "--border-2",
  "--border-3",
  "--muted",
  "--dim-a",
  "--dim-b",
  "--dim-c",
  "--accent",
  "--accent-bg",
  "--green",
  "--green-fill",
  "--red",
  "--err",
  "--red-strong",
  "--yellow",
  "--purple",
  "--cyan",
  "--think",
  "--cmdout",
  "--meta",
  "--args",
  "--hover-bg",
  "--hover-bg-2",
  "--x-hover-bg",
  "--u-fg",
  "--u-bg",
  "--u-border",
  "--ans",
  "--ans-bg",
  "--toggle-off",
  "--toggle-knob",
  "--scroll-thumb",
  "--scroll-thumb-hover",
  "--stab-thumb",
  "--stab-thumb-hover",
  "--pipe",
  "--rule",
  "--plan-line",
  "--plan-bar-fg",
  "--sec-h",
  "--sec-h-hover",
  "--stab-fg",
  "--overlay",
  "--sb-backdrop",
  "--shadow-menu",
  "--shadow-dd",
  "--shadow-modal",
] as const;

let info: OsThemeInfo | null = null;

type Rgb = [number, number, number];

function parseHex(value: string | undefined): Rgb | null {
  if (!value) return null;
  const match = value.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Linear mix: `t` is the share of `b`. */
function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a) ?? [0, 0, 0];
  const cb = parseHex(b) ?? [255, 255, 255];
  return toHex([
    ca[0] + (cb[0] - ca[0]) * t,
    ca[1] + (cb[1] - ca[1]) * t,
    ca[2] + (cb[2] - ca[2]) * t,
  ]);
}

function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex) ?? [0, 0, 0];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function palette(theme: OmarchyThemeInfo): Record<(typeof TOKEN_KEYS)[number], string> {
  const c = theme.colors;
  const bg = c.background ?? c.color0 ?? "#1a1b26";
  const fg = c.foreground ?? c.color7 ?? c.bright_foreground ?? "#a9b1d6";
  const accent = c.accent ?? c.blue ?? c.color4 ?? "#7aa2f7";
  const red = c.red ?? c.color1 ?? "#f7768e";
  const brightRed = c.bright_red ?? c.color9 ?? red;
  const green = c.green ?? c.color2 ?? "#9ece6a";
  const yellow = c.yellow ?? c.color3 ?? "#e0af68";
  const purple = c.magenta ?? c.color5 ?? "#ad8ee6";
  const cyan = c.cyan ?? c.color6 ?? "#449dab";
  const muted = c.muted ?? c.dark_foreground ?? c.color8 ?? mix(bg, fg, 0.55);
  const dim = c.dark_foreground ?? c.light_foreground ?? c.color8 ?? mix(bg, fg, 0.5);
  const light = theme.mode === "light" || luminance(bg) > 0.5;
  const panel = mix(bg, fg, 0.035);
  const surface = mix(bg, fg, 0.06);
  const border = mix(bg, fg, 0.13);
  const border2 = mix(bg, fg, 0.19);
  const dimA = mix(bg, fg, 0.45);
  const dimB = muted === mix(bg, fg, 0.55) ? mix(bg, fg, 0.36) : muted;
  const dimC = mix(bg, fg, 0.3);

  return {
    "--bg": bg,
    "--fg": fg,
    "--panel": panel,
    "--sb-bg": mix(bg, fg, 0.025),
    "--stab-bg": mix(bg, fg, 0.025),
    "--surface": surface,
    "--input-surface": surface,
    "--inp-bg": mix(bg, fg, 0.045),
    "--inp-border": alpha(accent, 0.28),
    "--inp-focus": accent,
    "--input-shadow": alpha(accent, 0.2),
    "--border": border,
    "--border-2": border2,
    "--border-3": border,
    "--muted": muted,
    "--dim-a": dimA,
    "--dim-b": dimB,
    "--dim-c": dimC,
    "--accent": accent,
    "--accent-bg": mix(bg, accent, 0.16),
    "--green": green,
    "--green-fill": green,
    "--red": red,
    "--err": red,
    "--red-strong": brightRed,
    "--yellow": yellow,
    "--purple": purple,
    "--cyan": cyan,
    "--think": dimA,
    "--cmdout": muted,
    "--meta": dimA,
    "--args": dimA,
    "--hover-bg": mix(bg, fg, 0.1),
    "--hover-bg-2": mix(bg, fg, 0.06),
    "--x-hover-bg": mix(bg, red, 0.14),
    "--u-fg": mix(fg, bg, 0.1),
    "--u-bg": mix(bg, accent, 0.12),
    "--u-border": mix(bg, accent, 0.55),
    "--ans": mix(fg, bg, 0.08),
    "--ans-bg": alpha(accent, 0.06),
    "--toggle-off": mix(bg, fg, 0.17),
    "--toggle-knob": dimA,
    "--scroll-thumb": mix(bg, fg, 0.22),
    "--scroll-thumb-hover": accent,
    "--stab-thumb": mix(bg, fg, 0.22),
    "--stab-thumb-hover": accent,
    "--pipe": border,
    "--rule": border,
    "--plan-line": border,
    "--plan-bar-fg": dimA,
    "--sec-h": dimA,
    "--sec-h-hover": accent,
    "--stab-fg": dimB,
    "--overlay": light ? "rgba(20, 20, 22, 0.32)" : "rgba(0, 0, 0, 0.62)",
    "--sb-backdrop": light ? "rgba(20, 20, 22, 0.24)" : "rgba(0, 0, 0, 0.48)",
    "--shadow-menu": light
      ? "0 8px 24px rgba(31, 35, 40, 0.18)"
      : "0 8px 24px rgba(0, 0, 0, 0.5)",
    "--shadow-dd": light
      ? "0 12px 32px rgba(31, 35, 40, 0.2)"
      : "0 12px 32px rgba(0, 0, 0, 0.55)",
    "--shadow-modal": light
      ? "0 20px 60px rgba(31, 35, 40, 0.24)"
      : "0 20px 60px rgba(0, 0, 0, 0.6)",
  };
}

/** Stores the server snapshot (platform + active Omarchy colours). */
export function setOsThemeInfo(next: OsThemeInfo | null): void {
  info = next && typeof next === "object" ? next : null;
}

/** `true` only when the server runs on Linux. */
export function osThemesAvailable(): boolean {
  return info?.available === true;
}

/** `true` after `/api/os-theme` answered (before that the platform is unknown). */
export function osThemeKnown(): boolean {
  return info !== null;
}

/** Active Omarchy theme, if any. */
export function activeOmarchyTheme(): OmarchyThemeInfo | null {
  return info?.omarchy ?? null;
}

/** Applies runtime colours inline; falls back to `omarchy.css` when absent. */
export function applyOmarchyVars(): void {
  const theme = activeOmarchyTheme();
  const body = document.body;
  if (!body || !theme) {
    clearOmarchyVars();
    return;
  }
  const tokens = palette(theme);
  for (const key of TOKEN_KEYS) body.style.setProperty(key, tokens[key]);
}

/** Removes runtime colours so another skin is not tinted by Omarchy tokens. */
export function clearOmarchyVars(): void {
  const body = document.body;
  if (!body) return;
  for (const key of TOKEN_KEYS) body.style.removeProperty(key);
}
