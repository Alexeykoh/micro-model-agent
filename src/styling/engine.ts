import pc from 'picocolors';
import type { ThemeConfig, ThemeColors, ThemeIcons, ThemeFormat } from './types.js';

/**
 * Движок тем — применяет цвета и иконки из конфигурации темы.
 *
 * Использует picocolors для terminal-цветов.
 * Все методы возвращают стилизованные строки.
 *
 * @module styling/engine
 */

// ─── Маппинг имён цветов к функциям picocolors ───────────
const COLOR_FN: Record<string, (s: string) => string> = {
  dim: pc.dim,
  bold: pc.bold,
  italic: pc.italic,
  underline: pc.underline,
  strikethrough: pc.strikethrough,
  reset: pc.reset,
  black: pc.black,
  red: pc.red,
  green: pc.green,
  yellow: pc.yellow,
  blue: pc.blue,
  magenta: pc.magenta,
  cyan: pc.cyan,
  white: pc.white,
  gray: pc.gray,
  bgRed: pc.bgRed,
  bgGreen: pc.bgGreen,
  bgYellow: pc.bgYellow,
  bgBlue: pc.bgBlue,
  bgMagenta: pc.bgMagenta,
  bgCyan: pc.bgCyan,
  bgWhite: pc.bgWhite,
};

/** Интерфейс движка темы — предоставляет методы для стилизации вывода */
export interface ThemeEngine {
  icon: ThemeIcons;
  indent: string;
  indentSize: number;

  prompt(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  info(text: string): string;
  dim(text: string): string;
  toolName(text: string): string;
  timing(text: string): string;
  highlight(text: string): string;
  lineNumbers(text: string): string;
  filePath(text: string): string;
  link(text: string): string;
  heading(text: string): string;
  symbolName(text: string): string;
  symbolType(text: string): string;
  bracket(text: string): string;
  userRole(text: string): string;
  assistantRole(text: string): string;
  subagentRole(text: string): string;
  expertRole(text: string): string;
  bracketTag(tag: string, message: string): string;
  toolHeader(name: string): string;
  contextBar(pct: number, length?: number): string;
  stepIcon(status: string): string;
  successMsg(text: string): string;
  errorMsg(text: string): string;
  spinner(text?: string): string;
  timingLine(seconds: string, exitCode?: number): string;
  separatorLine(): string;
}

/** Маппинг тегов bracket к цветам ролей */
const ROLE_TAG_COLORS: Record<string, keyof ThemeColors> = {
  user: 'user',
  assistant: 'assistant',
  subagent: 'subagent',
  expert: 'expert',
  specialist: 'expert',
};

/** Создаёт экземпляр движка темы из конфигурации */
export function createThemeEngine(config: ThemeConfig): ThemeEngine {
  const color: Record<string, (s: string) => string> = {};
  for (const [key, val] of Object.entries(config.colors)) {
    color[key] = COLOR_FN[val] || ((s: string) => s);
  }
  const icons = { ...config.icons };
  const format = { ...config.format };

  function c(name: keyof ThemeColors): (s: string) => string {
    return color[name] || ((s: string) => s);
  }

  return {
    get icon() { return icons; },
    get indent() { return format.indent; },
    get indentSize() { return format.indentSize; },

    prompt(text: string): string { return c('prompt')(text); },
    success(text: string): string { return c('success')(text); },
    error(text: string): string { return c('error')(text); },
    warning(text: string): string { return c('warning')(text); },
    info(text: string): string { return c('info')(text); },
    dim(text: string): string { return c('dim')(text); },
    toolName(text: string): string { return c('toolName')(text); },
    timing(text: string): string { return c('timing')(text); },
    highlight(text: string): string { return c('highlight')(text); },
    lineNumbers(text: string): string { return c('lineNumbers')(text); },
    filePath(text: string): string { return c('filePath')(text); },
    link(text: string): string { return c('link')(text); },
    heading(text: string): string { return c('heading')(text); },
    symbolName(text: string): string { return c('symbolName')(text); },
    symbolType(text: string): string { return c('symbolType')(text); },
    bracket(text: string): string { return c('bracket')(text); },
    userRole(text: string): string { return c('user')(text); },
    assistantRole(text: string): string { return c('assistant')(text); },
    subagentRole(text: string): string { return c('subagent')(text); },
    expertRole(text: string): string { return c('expert')(text); },

    bracketTag(tag: string, message: string): string {
      const roleKey = ROLE_TAG_COLORS[tag];
      if (roleKey) {
        const tagStr = c(roleKey)('[' + tag + ']');
        const msgStr = roleKey === 'user' ? c('highlight')(message) : message;
        return tagStr + ' ' + msgStr;
      }
      return c('dim')('[' + tag + ']') + ' ' + message;
    },

    toolHeader(name: string): string {
      return c('dim')('  ' + icons.separator + ' tool:') + ' ' + c('toolName')(name) + ' ' + c('dim')(icons.separator);
    },

    contextBar(pct: number, length = 20): string {
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      const filled = Math.round((clamped / 100) * length);
      const empty = Math.max(0, length - filled);
      const bar = icons.barFill.repeat(filled) + icons.barEmpty.repeat(empty);
      return c('contextBar')(bar);
    },

    stepIcon(status: string): string {
      if (status === 'done') return c('success')(icons.check);
      if (status === 'in_progress') return c('warning')(icons.inProgress);
      return c('dim')(icons.pending);
    },

    successMsg(text: string): string {
      return format.indent + c('success')(icons.success) + ' ' + text;
    },

    errorMsg(text: string): string {
      return format.indent + c('error')(icons.failure) + ' ' + text;
    },

    spinner(text: string = ''): string {
      return format.indent + c('dim')(icons.spinner) + (text ? ' ' + text : '');
    },

    timingLine(seconds: string, exitCode?: number): string {
      const label = exitCode !== undefined ? ' · exit ' + exitCode : '';
      return format.indent + c('timing')('⏱ ' + seconds + 's' + label);
    },

    separatorLine(): string {
      return c('dim')('  ' + icons.separator.repeat(20));
    },
  };
}
