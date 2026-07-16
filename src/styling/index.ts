import { ThemeEngine } from './engine.js';
import { loadTheme } from './loader.js';

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

export { ThemeEngine } from './engine.js';
export { loadTheme, ensureThemeDir } from './loader.js';
export type { ThemeConfig, ThemeColors, ThemeIcons, ThemeFormat } from './types.js';
