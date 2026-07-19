import { loadThemeConfig } from '../../styling/loader.js';

/**
 * Конвертация темы picocolors → Ink-стили.
 *
 * Конвертирует имена цветов (dim, bold, red и т.д.)
 * в формат Ink: { color: 'red', bold: true }.
 *
 * @module ui/ink/theme
 */

interface InkStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface InkTheme {
  colors: Record<string, InkStyle>;
  icons: Record<string, string>;
  format: { indent: string; indentSize: number };
}

const PICOLOR_TO_INK: Record<string, InkStyle> = {
  dim: { dim: true },
  bold: { bold: true },
  italic: { italic: true },
  underline: { underline: true },
  black: { color: 'black' },
  red: { color: 'red' },
  green: { color: 'green' },
  yellow: { color: 'yellow' },
  blue: { color: 'blue' },
  magenta: { color: 'magenta' },
  cyan: { color: 'cyan' },
  white: { color: 'white' },
  gray: { color: 'gray' },
  bgRed: { backgroundColor: 'red' },
  bgGreen: { backgroundColor: 'green' },
  bgYellow: { backgroundColor: 'yellow' },
  bgBlue: { backgroundColor: 'blue' },
  bgMagenta: { backgroundColor: 'magenta' },
  bgCyan: { backgroundColor: 'cyan' },
  bgWhite: { backgroundColor: 'white' },
};

let _inkTheme: InkTheme | null = null;

export function getInkTheme(): InkTheme {
  if (!_inkTheme) _inkTheme = buildInkTheme();
  return _inkTheme;
}

export function resetInkTheme(): void {
  _inkTheme = null;
}

function buildInkTheme(): InkTheme {
  const config = loadThemeConfig();
  const colors: Record<string, InkStyle> = {};
  for (const [key, val] of Object.entries(config.colors)) {
    colors[key] = PICOLOR_TO_INK[val] || {};
  }
  return {
    colors,
    icons: { ...config.icons },
    format: { ...config.format },
  };
}
