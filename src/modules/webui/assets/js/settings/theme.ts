// Применение темы веб-UI: классы на `<body>`, зеркало в `localStorage` и
// синхронизация с конфигом. Никаких записей на сервер здесь нет — POST живёт в
// `theme-panel.ts` (он уже импортирует `postConfig`), иначе получился бы цикл
// `write ↔ theme`.
//
// Контракт: docs/specs/2026-10-30-webui-theme-persistence-design.md (INV-T1/T2).
import { settings } from "../store.js";
import type { Dict } from "../core/store/types.js";
import { UI_THEME_IDS } from "./themes.js";
import { applyThemeWeather } from "./weather.js";
import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_SKIN,
  THEME_MODE_KEY,
  THEME_SKIN_KEY,
  isThemeMode,
  isThemeSkin,
  resolveThemeMode,
  resolveThemeSkin,
  themeModeMigration,
  themeSkinMigration,
} from "./theme-state.js";

// Последнее применённое значение. Нужно, чтобы пикер подсвечивал выбор сразу,
// не дожидаясь ответа `POST /api/config`, и чтобы `loadConfig` мог сбросить
// локальный оверрайд и вернуться к серверной правде.
let appliedMode: string | null = null;
let appliedSkin: string | null = null;
// Миграция кэша — один раз за загрузку страницы (INV-T5).
let migrated = false;

function cacheGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // приватный режим / заблокированное хранилище
  }
}

function cacheSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватный режим: тема всё равно применится, просто без кэша */
  }
}

function configUi(): Dict {
  const ui = settings.config ? settings.config.ui : undefined;
  return ui && typeof ui === "object" ? ui : {};
}

/** Действующий режим (конфиг → локальный оверрайд → кэш → дефолт). */
export function currentTheme(): string {
  return appliedMode ?? resolveThemeMode(configUi().themeMode, cacheGet(THEME_MODE_KEY));
}

/** Действующий скин. */
export function currentUiTheme(): string {
  return appliedSkin ?? resolveThemeSkin(configUi().theme, cacheGet(THEME_SKIN_KEY));
}

/** Тёмный ли фон для режима (системная настройка читается только для `auto`). */
function isLight(mode: string): boolean {
  if (mode === "light") return true;
  return (
    mode === "auto" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  );
}

/** Применяет режим и зеркалит его в кэш. Невалидное значение → дефолт. */
export function applyTheme(theme: string): void {
  const mode = isThemeMode(theme) ? theme : DEFAULT_THEME_MODE;
  appliedMode = mode;
  cacheSet(THEME_MODE_KEY, mode);
  document.body.classList.toggle("light", isLight(mode));
}

/** Применяет скин и зеркалит его в кэш. Невалидный id → дефолт. */
export function applyUiTheme(theme: string): void {
  const skin = isThemeSkin(theme) ? theme : DEFAULT_THEME_SKIN;
  appliedSkin = skin;
  cacheSet(THEME_SKIN_KEY, skin);
  for (const id of UI_THEME_IDS) document.body.classList.toggle(id, id === skin);
  applyThemeWeather(skin);
}

/**
 * Перечитывает тему из конфига: серверная правда важнее локального оверрайда и
 * старого кэша. Вызывается после `GET /api/config` (INV-T1) и при неудачной
 * миграции.
 */
export function syncThemeFromConfig(): void {
  appliedMode = null;
  appliedSkin = null;
  applyTheme(currentTheme());
  applyUiTheme(currentUiTheme());
}

/**
 * Доливает досерверный выбор темы из кэша в конфиг (INV-T5). `post` — шов
 * записи (`postConfig`), чтобы этот модуль не зависел от `write.ts`.
 *
 * @returns true, если хотя бы одна запись прошла (панель надо перерисовать).
 */
export async function migrateThemeCache(
  post: (key: string, value: string) => Promise<boolean>,
): Promise<boolean> {
  if (migrated) return false;
  migrated = true;
  const ui = configUi();
  const writes: Array<{ key: string; value: string; apply: (v: string) => void }> = [];
  const mode = themeModeMigration(ui.themeMode, cacheGet(THEME_MODE_KEY));
  if (mode) writes.push({ key: "ui.themeMode", value: mode, apply: applyTheme });
  const skin = themeSkinMigration(ui.theme, cacheGet(THEME_SKIN_KEY));
  if (skin) writes.push({ key: "ui.theme", value: skin, apply: applyUiTheme });
  if (!writes.length) return false;
  let changed = false;
  for (const write of writes) {
    write.apply(write.value);
    if (await post(write.key, write.value)) changed = true;
    else syncThemeFromConfig(); // сервер не принял — показываем его значение
  }
  return changed;
}

// Системная схема сменилась, а режим `auto` — перекрашиваем без перезагрузки.
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentTheme() === "auto") applyTheme("auto");
  });
}

