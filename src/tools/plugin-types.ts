// Контракт плагинов тулов: хуки до/после выполнения. Вынесено из `types.ts`
// (правило ≤300); реэкспортируется оттуда для совместимости.
import type { ToolCall, ToolContext, ToolResult } from "./types";

/** Хук плагина: перехват до/после выполнения тула. */
export interface PluginHook {
  name?: string;
  priority?: number;
  isBuiltin?: boolean;
  /**
   * Вернуть `false` — блокировать тул, строку — блокировать с причиной
   * (видит модель), `true` — разрешить.
   */
  onBeforeTool?(ctx: ToolContext, call: ToolCall): boolean | string | Promise<boolean | string>;
  onAfterTool?(ctx: ToolContext, call: ToolCall, result: ToolResult): void | Promise<void>;
}

/** Менеджер плагинов: доступ к зарегистрированным хукам. */
export interface PluginManager {
  getAllPlugins(): PluginHook[];
}
