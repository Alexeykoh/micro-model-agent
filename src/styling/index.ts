import { ThemeEngine } from './engine.js';
import { loadTheme, loadThemeConfig, listThemes as listThemeNames, ensureThemeDir } from './loader.js';

/**
 * Публичный API модуля тем.
 *
 * Предоставляет глобальный доступ к текущей теме:
 * - initTheme() — инициализация темы
 * - getTheme() — получение текущей темы (lazy init)
 * - switchTheme() — переключение темы
 * - listThemes() — список доступных тем
 *
 * @module styling/index
 */

let _theme: ThemeEngine | null = null;

/** Инициализирует тему по имени (по умолчанию light) */
export function initTheme(name?: string): ThemeEngine {
  _theme = loadTheme(name || 'light');
  return _theme;
}

/** Возвращает текущую тему (создаёт light если не инициализирована) */
export function getTheme(): ThemeEngine {
  if (!_theme) {
    _theme = loadTheme('light');
  }
  return _theme;
}

/** Возвращает список доступных тем */
export function listThemes(): string[] {
  return listThemeNames();
}

/** Переключает тему по имени */
export function switchTheme(name: string): ThemeEngine {
  _theme = loadTheme(name);
  return _theme;
}

/** Сбрасывает тему (следующий getTheme создаст light) */
export function resetTheme(): void {
  _theme = null;
}

export { ThemeEngine } from './engine.js';
export { loadTheme, loadThemeConfig, ensureThemeDir } from './loader.js';
export type { ThemeConfig, ThemeColors, ThemeIcons, ThemeFormat } from './types.js';
