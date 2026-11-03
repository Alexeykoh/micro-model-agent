/**
 * Обвязка плагин-хуков `ToolExecutor.execute()`: `onBeforeTool`/`onAfterTool`
 * гоняются под общим `AsyncLock` форков (см. `executor.ts`).
 */
import type { ToolContext, ToolResult, ToolCall, PluginHook } from "./types";
import { t } from "../i18n/index";

/**
 * Прогон `onBeforeTool` по всем плагинам (под hookLock). Возвращает
 * blocked-результат, если плагин отклонил вызов, иначе `null`.
 */
export async function runBeforeToolPlugins(
  ctx: ToolContext,
  call: ToolCall,
  plugins: PluginHook[],
): Promise<ToolResult | null> {
  for (const plugin of plugins) {
    if (!plugin.onBeforeTool) continue;
    try {
      const proceed = await plugin.onBeforeTool(ctx, call);
      if (proceed === false || typeof proceed === "string") {
        const pluginName =
          (plugin as { name?: string }).name || plugin.constructor?.name || "unknown";
        const reason = typeof proceed === "string" ? proceed : undefined;
        return {
          success: false,
          blocked: true,
          output: reason
            ? t("tool.blocked_reason", { plugin: pluginName, reason })
            : t("tool.blocked", { plugin: pluginName }),
          toolCallId: call.id,
        };
      }
    } catch (e: any) {
      ctx.logger.warn(`Plugin onBeforeTool error: ${e.message}`);
    }
  }
  return null;
}

/** Прогон `onAfterTool` по всем плагинам (под hookLock; `signal` в ctx хука). */
export async function runAfterToolPlugins(
  ctx: ToolContext,
  call: ToolCall,
  result: ToolResult,
  signal: AbortSignal | undefined,
  plugins: PluginHook[],
): Promise<void> {
  const pluginCtx = signal ? { ...ctx, signal } : ctx;
  for (const plugin of plugins) {
    if (!plugin.onAfterTool) continue;
    try {
      await plugin.onAfterTool(pluginCtx, call, result);
    } catch (e: any) {
      ctx.logger.warn(`Plugin onAfterTool error: ${e.message}`);
    }
  }
}
