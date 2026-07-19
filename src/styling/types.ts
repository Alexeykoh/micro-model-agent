/**
 * Типы тем оформления.
 *
 * Определяют структуру конфигурации тем:
 * - Цвета для различных элементов UI
 * - Иконки для статусов и разделителей
 * - Форматирование (отступы)
 *
 * @module styling/types
 */

/** Цвета темы */
export interface ThemeColors {
  prompt: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  dim: string;
  toolName: string;
  timing: string;
  contextBar: string;
  highlight: string;
  lineNumbers: string;
  filePath: string;
  link: string;
  heading: string;
  symbolName: string;
  symbolType: string;
  bracket: string;
}

/** Иконки темы */
export interface ThemeIcons {
  success: string;
  failure: string;
  spinner: string;
  inProgress: string;
  pending: string;
  separator: string;
  arrow: string;
  barFill: string;
  barEmpty: string;
  check: string;
  cross: string;
  bullet: string;
  subBullet: string;
  pipe: string;
}

/** Форматирование темы */
export interface ThemeFormat {
  indent: string;
  indentSize: number;
}

/** Полная конфигурация темы */
export interface ThemeConfig {
  name: string;
  colors: ThemeColors;
  icons: ThemeIcons;
  format: ThemeFormat;
}
