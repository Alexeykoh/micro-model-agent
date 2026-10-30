// Канонические id тем веб-UI для бэкенда (реестр конфига, типы, дефолты).
//
// Источник для правки каталога тем — фронтенд
// (`src/modules/webui/assets/js/settings/themes.ts`): там id, подписи и свотчи.
// Этот модуль существует, чтобы реестр конфига не собирал enum из литерала и не
// разошёлся с пикером молча; совпадение держит `tests/webui-themes.test.ts`.
// Дефолтный скин входит в список: `flat` — тоже скин (без своего stylesheet,
// поэтому в pre-paint whitelist и в списке классов его нет).

/** Id скинов веб-UI в порядке пикера (color → seasonal). */
export const UI_THEME_IDS = [
  "console",
  "groovebox",
  "flat",
  "neon",
  "paper",
  "contrast",
  "winter",
  "spring",
  "summer",
  "autumn",
] as const;

/** Id скина веб-UI. */
export type UiThemeId = (typeof UI_THEME_IDS)[number];

/** Режим оформления веб-UI: тёмный, светлый, по системной настройке. */
export const THEME_MODES = ["dark", "light", "auto"] as const;

/** Режим оформления веб-UI. */
export type ThemeMode = (typeof THEME_MODES)[number];
