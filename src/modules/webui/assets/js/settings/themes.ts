// Browser-local UI themes. The `id` is the body class consumed by
// `console.css`, `groovebox.css` and `themes.css`; `colors` are the three
// swatch dots shown on the settings card. Keep this list in sync with the
// pre-paint whitelist in `index.html` (guarded by tests/webui-themes.test.ts).
export interface UiTheme {
  id: string;
  /** Picker section: base/color themes vs seasonal ones. */
  group: "color" | "seasonal";
  /** [ground, accent, secondary] — preview only. */
  colors: readonly [string, string, string];
}

export const UI_THEMES: readonly UiTheme[] = [
  { id: "console", group: "color", colors: ["#0a0a0b", "#d0cecc", "#86d992"] },
  { id: "groovebox", group: "color", colors: ["#120e16", "#ff7ac6", "#6fe3ff"] },
  { id: "flat", group: "color", colors: ["#141414", "#e6edf3", "#c4a8ec"] },
  { id: "neon", group: "color", colors: ["#07060f", "#ff3ec8", "#3ee8ff"] },
  { id: "paper", group: "color", colors: ["#f7f0e2", "#a33a2c", "#3f6f3a"] },
  { id: "contrast", group: "color", colors: ["#000000", "#ffd400", "#ffffff"] },
  { id: "winter", group: "seasonal", colors: ["#071019", "#9fdcff", "#ffffff"] },
  { id: "spring", group: "seasonal", colors: ["#fdf8fb", "#b02a68", "#9be59b"] },
  { id: "summer", group: "seasonal", colors: ["#04141a", "#ffd34d", "#4fe3d7"] },
  { id: "autumn", group: "seasonal", colors: ["#170d08", "#ff9a3d", "#ffc857"] },
];

/** Class names to add/remove on `<body>` (`flat` has no stylesheet of its own). */
export const UI_THEME_IDS: readonly string[] = UI_THEMES.map((t) => t.id).filter(
  (id) => id !== "flat",
);
