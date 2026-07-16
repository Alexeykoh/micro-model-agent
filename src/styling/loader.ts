import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ThemeConfig } from './types.js';
import { ThemeEngine } from './engine.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MMA_DIR = join(homedir(), '.mma');
const THEMES_DIR = join(MMA_DIR, 'themes');

const BUILT_IN_THEMES: Record<string, ThemeConfig> = {
  light: {
    name: 'light',
    colors: {
      prompt: 'cyan', success: 'green', error: 'red', warning: 'yellow',
      info: 'blue', dim: 'dim', toolName: 'magenta', timing: 'yellow',
      contextBar: 'cyan', highlight: 'bold', lineNumbers: 'dim',
      filePath: 'cyan', link: 'underline', heading: 'bold',
      symbolName: 'yellow', symbolType: 'dim', bracket: 'dim',
    },
    icons: {
      success: '✓', failure: '✗', spinner: '⏳', inProgress: '~',
      pending: ' ', separator: '──', arrow: '→',
      barFill: '█', barEmpty: '░', check: '✓', cross: '✗',
      bullet: '├──', subBullet: '│   ├──', pipe: '│',
    },
    format: { indent: '  ', indentSize: 2 },
  },
  dark: {
    name: 'dark',
    colors: {
      prompt: 'cyan', success: 'green', error: 'red', warning: 'yellow',
      info: 'cyan', dim: 'dim', toolName: 'magenta', timing: 'yellow',
      contextBar: 'cyan', highlight: 'bold', lineNumbers: 'dim',
      filePath: 'cyan', link: 'underline', heading: 'bold',
      symbolName: 'yellow', symbolType: 'dim', bracket: 'dim',
    },
    icons: {
      success: '✓', failure: '✗', spinner: '⏳', inProgress: '~',
      pending: ' ', separator: '──', arrow: '→',
      barFill: '█', barEmpty: '░', check: '✓', cross: '✗',
      bullet: '├──', subBullet: '│   ├──', pipe: '│',
    },
    format: { indent: '  ', indentSize: 2 },
  },
};

function loadJsonTheme(name: string): ThemeConfig | null {
  const path = join(THEMES_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function mergeTheme(base: ThemeConfig, overrides: Partial<ThemeConfig>): ThemeConfig {
  return {
    ...base,
    ...overrides,
    colors: { ...base.colors, ...overrides.colors },
    icons: { ...base.icons, ...overrides.icons },
    format: { ...base.format, ...overrides.format },
  };
}

export function loadTheme(name: string = 'light'): ThemeEngine {
  const builtIn = BUILT_IN_THEMES[name] || BUILT_IN_THEMES.light;
  const custom = loadJsonTheme(name);
  const config = custom ? mergeTheme(builtIn, custom) : builtIn;
  return new ThemeEngine(config);
}

export function ensureThemeDir(): void {
  if (!existsSync(THEMES_DIR)) {
    mkdirSync(THEMES_DIR, { recursive: true });
  }
}
