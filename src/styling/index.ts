import { ThemeEngine } from './engine.js';
import { loadTheme, loadThemeConfig, listThemes as listThemeNames, ensureThemeDir } from './loader.js';

let _theme: ThemeEngine | null = null;

export function initTheme(name?: string): ThemeEngine {
  _theme = loadTheme(name || 'light');
  return _theme;
}

export function getTheme(): ThemeEngine {
  if (!_theme) {
    _theme = loadTheme('light');
  }
  return _theme;
}

export function listThemes(): string[] {
  return listThemeNames();
}

export function switchTheme(name: string): ThemeEngine {
  _theme = loadTheme(name);
  return _theme;
}

export function resetTheme(): void {
  _theme = null;
}

export { ThemeEngine } from './engine.js';
export { loadTheme, loadThemeConfig, ensureThemeDir } from './loader.js';
export type { ThemeConfig, ThemeColors, ThemeIcons, ThemeFormat } from './types.js';
