import type { ToolDefinition } from '../registry.js';
import type { ToolHandler } from '../types.js';
import { listThemes, switchTheme } from '../../styling/index.js';
import { loadThemeConfig, installTheme, removeTheme } from '../../styling/loader.js';
import { loadConfig, saveConfig } from '../../config/config.js';

/**
 * Нативный инструмент theme — управление темами оформления.
 *
 * @module tools/native/theme
 */

export const themeDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'theme',
    description: 'Manage UI themes. Actions: list, show, switch, install, remove.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list, show, switch, install, remove' },
        name: { type: 'string', description: 'Theme name (for switch/install/remove)' },
        url: { type: 'string', description: 'Theme URL (for install)' },
      },
      required: ['action'],
    },
  },
};

export const themeHandler: ToolHandler = {
  name: 'theme',
  definition: themeDefinition,
  async execute(args, ctx) {
    const action = String(args.action || 'list');
    const name = String(args.name || '');
    const url = String(args.url || '');

    if (!ctx.quiet) {
      ctx.renderer?.writeBracketTag('theme', action);
    }

    let output = '';
    let exitCode = 0;

    switch (action) {
      case 'list': {
        const allThemes = listThemes();
        const current = loadThemeConfig().name;
        output = `Available themes (${allThemes.length}):\n`;
        for (const t of allThemes) {
          output += `  ${t}${t === current ? ' (active)' : ''}\n`;
        }
        break;
      }
      case 'show': {
        const config = loadThemeConfig();
        output = `Theme: ${config.name}\nColors: ${JSON.stringify(config.colors, null, 2)}\nIcons: ${JSON.stringify(config.icons, null, 2)}`;
        break;
      }
      case 'switch': {
        const allThemes = listThemes();
        if (!allThemes.includes(name)) {
          output = `Unknown theme "${name}". Available: ${allThemes.join(', ')}`;
          exitCode = 1;
          break;
        }
        const appConfig = loadConfig();
        appConfig.theme = name;
        saveConfig(appConfig);
        switchTheme(name);
        try {
          const { resetInkTheme } = await import('../../ui/ink/theme.js');
          resetInkTheme();
        } catch { /* not in ink mode */ }
        output = `Theme switched to "${name}"`;
        break;
      }
      case 'install': {
        if (!name || !url) {
          output = 'Usage: theme install <name> <url>';
          exitCode = 1;
          break;
        }
        try {
          const resp = await fetch(url);
          const text = await resp.text();
          JSON.parse(text);
          installTheme(name, text);
          output = `Theme "${name}" installed from ${url}`;
        } catch (e: any) {
          output = `Failed to install theme: ${e.message}`;
          exitCode = 1;
        }
        break;
      }
      case 'remove': {
        if (!removeTheme(name)) {
          output = `Theme "${name}" not found`;
          exitCode = 1;
          break;
        }
        output = `Theme "${name}" removed`;
        break;
      }
      default:
        output = 'Unknown theme action. Use: list, show, switch, install, remove';
        exitCode = 1;
    }

    return { stdout: output, stderr: '', exitCode, truncated: false };
  },
};
