// Чистые правила резолва и миграции темы веб-UI: без DOM, `localStorage` и
// `settings`, чтобы их можно было проверить без браузера.
//
// Источник правды — конфиг (`ui.theme` / `ui.themeMode`); кэш в браузере нужен
// только для отрисовки до первого `GET /api/config`. См.
// docs/specs/2026-10-30-webui-theme-persistence-design.md.
import { UI_THEMES } from "./themes.js";

/** Ключ кэша режима оформления (`localStorage`). */
export const THEME_MODE_KEY = "mma-theme";
/** Ключ кэша скина (`localStorage`). */
export const THEME_SKIN_KEY = "mma-ui-theme";

/** Режимы оформления в порядке сегмента. */
export const THEME_MODES = ["dark", "light", "auto"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Дефолты совпадают с `DEFAULTS.ui.*` (см. src/config/defaults.ts). */
export const DEFAULT_THEME_MODE: ThemeMode = "auto";
export const DEFAULT_THEME_SKIN = "console";

/** Все id скинов, включая `flat` (у него нет своего stylesheet и класса). */
export const THEME_SKIN_IDS: readonly string[] = UI_THEMES.map((t) => t.id);

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

export function isThemeSkin(value: unknown): value is string {
  return typeof value === "string" && THEME_SKIN_IDS.includes(value);
}

/**
 * Действующий режим: значение из конфига, иначе кэш, иначе дефолт. Невалидные
 * значения (битый конфиг, старый кэш) отбрасываются, а не применяются как есть.
 */
export function resolveThemeMode(configValue: unknown, cached: string | null): ThemeMode {
  if (isThemeMode(configValue)) return configValue;
  if (isThemeMode(cached)) return cached;
  return DEFAULT_THEME_MODE;
}

/** Действующий скин — та же лестница «конфиг → кэш → дефолт». */
export function resolveThemeSkin(configValue: unknown, cached: string | null): string {
  if (isThemeSkin(configValue)) return configValue;
  if (isThemeSkin(cached)) return cached;
  return DEFAULT_THEME_SKIN;
}

/**
 * Значение, которое надо долить в конфиг при апгрейде (INV-T5): только если
 * сервер ещё на дефолте, а кэш этого origin — валидное не-дефолтное значение.
 * Иначе `null` — писать нечего.
 */
export function themeModeMigration(configValue: unknown, cached: string | null): ThemeMode | null {
  if (isThemeMode(configValue) && configValue !== DEFAULT_THEME_MODE) return null;
  return isThemeMode(cached) && cached !== DEFAULT_THEME_MODE ? cached : null;
}

/** Скин: то же правило, что у режима. */
export function themeSkinMigration(configValue: unknown, cached: string | null): string | null {
  if (isThemeSkin(configValue) && configValue !== DEFAULT_THEME_SKIN) return null;
  return isThemeSkin(cached) && cached !== DEFAULT_THEME_SKIN ? cached : null;
}
