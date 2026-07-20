import type { ToolResult, ParsedToolCall } from '../tools/types.js';

/**
 * Типы системы плагинов.
 *
 * Variant C — lifecycle events. Плагин подписывается на события,
 * ядро диспатчит. Новые события добавляются без изменения интерфейса плагина.
 *
 * @module plugins/types
 */

/** Все события системы */
export type PluginEvent =
  // Agent lifecycle
  | 'agent:init'
  | 'agent:step'
  | 'agent:done'
  // Tool lifecycle
  | 'tool:before'
  | 'tool:after'
  | 'tool:blocked'
  // LLM lifecycle
  | 'llm:before'
  | 'llm:after'
  // Prompt
  | 'prompt:build'
  // Session
  | 'session:save'
  | 'session:load'
  // Mode
  | 'mode:switch'
  // Plugin lifecycle
  | 'plugin:loaded'
  | 'plugin:error';

/** Тип обработчика события */
export type PluginHandler<T = unknown> = (...args: any[]) => T | void | Promise<T | void>;

/** Контекст плагина */
export interface PluginContext {
  /** Рабочая директория */
  cwd: string;
  /** Конфиг плагина (из manifest.json + .mmrc override) */
  config: Record<string, unknown>;
  /** Логгер */
  logger: PluginLogger;
}

/** Логгер плагина */
export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** Ошибка плагина (для блокировки инструмента) */
export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginError';
  }
}

/** Интерфейс плагина */
export interface AgentPlugin {
  /** Уникальное имя плагина */
  name: string;
  /** Версия (optional) */
  version?: string;
  /** Описание */
  description?: string;

  /** Активация плагина */
  onActivate?(ctx: PluginContext): void | Promise<void>;
  /** Деактивация плагина */
  onDeactivate?(): void | Promise<void>;

  /** Подписка на событие */
  on?(event: PluginEvent, handler: PluginHandler): void;

  /** Добавить секцию в system prompt */
  getPromptSection?(): string | Promise<string>;

  /** Добавить behaviors */
  getBehaviors?(): Record<string, unknown>;
}

/** Манифест плагина */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  entry: string;
  /** Какие события слушает (для оптимизации) */
  events?: PluginEvent[];
  /** Зависимости от других плагинов */
  dependencies?: Record<string, string>;
  /** Конфиг плагина (пользователь переопределяет в .mmrc) */
  config?: Record<string, unknown>;
}

/** Информация о загруженном плагине */
export interface PluginInfo {
  name: string;
  version?: string;
  description?: string;
  active: boolean;
  events: PluginEvent[];
}
