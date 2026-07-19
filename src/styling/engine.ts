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

/** Движок темы — предоставляет методы для стилизации вывода */
export class ThemeEngine {
  private _color: Record<string, (s: string) => string>;
  private _icons: ThemeIcons;
  private _format: ThemeFormat;

  constructor(config: ThemeConfig) {
    this._color = {};
    for (const [key, val] of Object.entries(config.colors)) {
      this._color[key] = COLOR_FN[val] || ((s: string) => s);
    }
    this._icons = { ...config.icons };
    this._format = { ...config.format };
  }

  private c(name: keyof ThemeColors): (s: string) => string {
    return this._color[name] || ((s: string) => s);
  }

  prompt(text: string): string {
    return this.c('prompt')(text);
  }

  success(text: string): string {
    return this.c('success')(text);
  }

  error(text: string): string {
    return this.c('error')(text);
  }

  warning(text: string): string {
    return this.c('warning')(text);
  }

  info(text: string): string {
    return this.c('info')(text);
  }

  dim(text: string): string {
    return this.c('dim')(text);
  }

  toolName(text: string): string {
    return this.c('toolName')(text);
  }

  timing(text: string): string {
    return this.c('timing')(text);
  }

  highlight(text: string): string {
    return this.c('highlight')(text);
  }

  lineNumbers(text: string): string {
    return this.c('lineNumbers')(text);
  }

  filePath(text: string): string {
    return this.c('filePath')(text);
  }

  link(text: string): string {
    return this.c('link')(text);
  }

  heading(text: string): string {
    return this.c('heading')(text);
  }

  symbolName(text: string): string {
    return this.c('symbolName')(text);
  }

  symbolType(text: string): string {
    return this.c('symbolType')(text);
  }

  bracket(text: string): string {
    return this.c('bracket')(text);
  }

  get icon(): ThemeIcons {
    return this._icons;
  }

  get indent(): string {
    return this._format.indent;
  }

  get indentSize(): number {
    return this._format.indentSize;
  }

  bracketTag(tag: string, message: string): string {
    if (tag === 'user') {
      return `${this.c('info')(`[${tag}]`)} ${this.c('highlight')(message)}`;
    }
    return `${this.dim(`[${tag}]`)} ${message}`;
  }

  toolHeader(name: string): string {
    return `${this.dim(`  ${this._icons.separator} tool:`)} ${this.toolName(name)} ${this.dim(this._icons.separator)}`;
  }

  contextBar(pct: number, length = 20): string {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    const filled = Math.round((clamped / 100) * length);
    const empty = Math.max(0, length - filled);
    const bar = this._icons.barFill.repeat(filled) + this._icons.barEmpty.repeat(empty);
    return this.c('contextBar')(bar);
  }

  stepIcon(status: string): string {
    if (status === 'done') return this.success(this._icons.check);
    if (status === 'in_progress') return this.warning(this._icons.inProgress);
    return this.dim(this._icons.pending);
  }

  successMsg(text: string): string {
    return `${this.indent}${this.success(this._icons.success)} ${text}`;
  }

  errorMsg(text: string): string {
    return `${this.indent}${this.error(this._icons.failure)} ${text}`;
  }

  spinner(text = ''): string {
    return `${this.indent}${this.dim(this._icons.spinner)}${text ? ' ' + text : ''}`;
  }

  timingLine(seconds: string, exitCode?: number): string {
    const label = exitCode !== undefined ? ` · exit ${exitCode}` : '';
    return `${this.indent}${this.timing(`⏱ ${seconds}s${label}`)}`;
  }

  separatorLine(): string {
    return this.dim(`  ${this._icons.separator.repeat(20)}`);
  }
}
