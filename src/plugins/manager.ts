import type { AgentPlugin, PluginEvent, PluginHandler, PluginContext, PluginInfo, PluginSource } from './types.js';
import { logInfo, logWarn, logError } from '../logger.js';

/**
 * Менеджер плагинов с event bus.
 *
 * Variant C — lifecycle events. Плагины подписываются на события,
 * ядро диспатчит через emit/emitAsync.
 *
 * Middleware chain: каждый handler получает результат предыдущего.
 * void = пропуск. PluginError = блокировка.
 *
 * @module plugins/manager
 */

/** Результат middleware chain */
interface MiddlewareResult<T> {
  value: T;
  blocked: boolean;
  blockReason?: string;
}

/**
 * Менеджер плагинов.
 *
 * Использование:
 * ```ts
 * const pm = new PluginManager();
 * pm.register(myPlugin);
 * await pm.emit('tool:before', toolName, args);
 * const sections = pm.getPromptSections();
 * ```
 */
export class PluginManager {
  private plugins: Map<string, AgentPlugin> = new Map();
  private listeners: Map<PluginEvent, Map<string, PluginHandler>> = new Map();
  private active: Set<string> = new Set();
  private sources: Map<string, PluginSource> = new Map();

  /** Регистрация плагина */
  register(plugin: AgentPlugin, source: PluginSource = 'user'): void {
    this.plugins.set(plugin.name, plugin);
    this.sources.set(plugin.name, source);
    logInfo('PLUGIN', `registered: ${plugin.name}${plugin.version ? ` v${plugin.version}` : ''} (${source})`);
  }

  /** Активация плагина */
  async activate(name: string, ctx: PluginContext): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      logWarn('PLUGIN', `activate: unknown plugin "${name}"`);
      return;
    }
    if (this.active.has(name)) return;

    try {
      await plugin.onActivate?.(ctx);
      this.active.add(name);
      logInfo('PLUGIN', `activated: ${name}`);
    } catch (e: any) {
      logError('PLUGIN', `activate failed: ${name}: ${e.message}`);
    }
  }

  /** Деактивация плагина */
  async deactivate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin || !this.active.has(name)) return;

    try {
      await plugin.onDeactivate?.();
      this.active.delete(name);
      logInfo('PLUGIN', `deactivated: ${name}`);
    } catch (e: any) {
      logError('PLUGIN', `deactivate failed: ${name}: ${e.message}`);
    }
  }

  /** Активация нескольких плагинов */
  async activateAll(names: string[], ctx: PluginContext): Promise<void> {
    for (const name of names) {
      await this.activate(name, ctx);
    }
  }

  /** Подписка на событие (внутренняя, вызывается при register) */
  on(event: PluginEvent, pluginName: string, handler: PluginHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Map());
    }
    this.listeners.get(event)!.set(`${pluginName}:${event}`, handler);
  }

  /**
   * Диспатч события (sync middleware chain).
   *
   * Каждый handler получает результат предыдущего.
   * Возвращает финальное значение после всех handler'ов.
   */
  async emit<T>(event: PluginEvent, ...args: unknown[]): Promise<T | undefined> {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) return undefined;

    let value: T | undefined = undefined;

    for (const [key, handler] of Array.from(eventListeners.entries())) {
      const pluginName = key.split(':')[0];
      if (!this.active.has(pluginName)) continue;

      try {
        const result = await handler(...args, value);
        if (result !== undefined && result !== null) {
          value = result as T;
        }
      } catch (e: any) {
        if (e.name === 'PluginError') {
          logWarn('PLUGIN', `blocked by ${pluginName}: ${e.message}`);
          throw e;
        }
        logError('PLUGIN', `event ${event} handler ${pluginName} error: ${e.message}`);
      }
    }

    return value;
  }

  /**
   * Диспатч события с middleware chain для модификации данных.
   *
   * Handler может вернуть модифицированное значение или void (пропуск).
   * Возвращает финальное значение.
   */
  async emitModify<T>(event: PluginEvent, initial: T, ...args: unknown[]): Promise<T> {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners || eventListeners.size === 0) return initial;

    let current = initial;

    for (const [key, handler] of Array.from(eventListeners.entries())) {
      const pluginName = key.split(':')[0];
      if (!this.active.has(pluginName)) continue;

      try {
        const result = await handler(current, ...args);
        if (result !== undefined && result !== null) {
          current = result as T;
        }
      } catch (e: any) {
        if (e.name === 'PluginError') throw e;
        logError('PLUGIN', `emitModify ${event} handler ${pluginName} error: ${e.message}`);
      }
    }

    return current;
  }

  /** Агрегация секций system prompt от всех плагинов */
  async getPromptSections(): Promise<string[]> {
    const sections: string[] = [];

    for (const [name, plugin] of Array.from(this.plugins.entries())) {
      if (!this.active.has(name)) continue;
      if (!plugin.getPromptSection) continue;

      try {
        const section = await plugin.getPromptSection();
        if (section) sections.push(section);
      } catch (e: any) {
        logError('PLUGIN', `getPromptSection ${name} error: ${e.message}`);
      }
    }

    return sections;
  }

  /** Агрегация behaviors от всех плагинов */
  async getBehaviors(): Promise<Record<string, unknown>> {
    const behaviors: Record<string, unknown> = {};

    for (const [name, plugin] of Array.from(this.plugins.entries())) {
      if (!this.active.has(name)) continue;
      if (!plugin.getBehaviors) continue;

      try {
        const pluginBehaviors = await plugin.getBehaviors();
        Object.assign(behaviors, pluginBehaviors);
      } catch (e: any) {
        logError('PLUGIN', `getBehaviors ${name} error: ${e.message}`);
      }
    }

    return behaviors;
  }

  /** Список загруженных плагинов */
  listPlugins(): PluginInfo[] {
    return Array.from(this.plugins.entries()).map(([name, plugin]) => ({
      name,
      version: plugin.version,
      description: plugin.description,
      active: this.active.has(name),
      events: [],
      source: this.sources.get(name) || 'user',
    }));
  }

  /** Получить список активных плагинов (имена) */
  getActivePluginNames(): string[] {
    return Array.from(this.active);
  }

  /** Проверка активности плагина */
  isActive(name: string): boolean {
    return this.active.has(name);
  }

  /** Проверка наличия плагина */
  has(name: string): boolean {
    return this.plugins.has(name);
  }
}