// Имена, мета и валидация определений тулов плагинов — вынесено из `tools.ts`
// (правило ≤300). Чистые функции без состояния реестра.
import type { ToolDefinition, ToolResult } from "../../tools/types";

/** Префикс тега плагина (`plugin:<name>`). */
const PLUGIN_TAG_PREFIX = "plugin:";

/** Приготовленный к внесению тул: имя в реестре, плагин-владелец и определение. */
export interface PreparedTool {
  name: string;
  plugin: string;
  def: ToolDefinition;
}

/** Что именно внёс один плагин (или почему ничего). */
export interface PluginContribution {
  tools: PreparedTool[];
  conflicts: Array<{ plugin: string; tool: string; reason: "conflict" | "invalid"; detail: string }>;
}

/**
 * Владелец имени по тегу в самом определении. Нужно, т.к. `buildRunnerRegistry`
 * клонирует определения в реестр сессии, и клон приходит без записи о владельце;
 * тег переживает клонирование.
 */
export function ownerByTag(def: ToolDefinition | undefined): string | undefined {
  for (const tag of def?.tags ?? []) {
    if (tag.startsWith(PLUGIN_TAG_PREFIX)) return tag.slice(PLUGIN_TAG_PREFIX.length);
  }
  return undefined;
}

/** Тег тула плагина: `plugin:<name>` — по нему тул узнаётся в UI и отчётах. */
export function pluginToolTag(plugin: string): string {
  return `${PLUGIN_TAG_PREFIX}${plugin}`;
}

/**
 * Имя тула в реестре: `plugin__<плагин>__<тул>` — по образцу `mcp__<server>__<tool>`.
 * Префикс снимает почти все коллизии с ядром и делает происхождение видимым.
 */
export function pluginToolName(plugin: string, tool: string): string {
  const safePlugin = plugin.replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `plugin__${safePlugin}__${safeTool}`;
}

/**
 * Нормализация результата тула плагина. Плагин часто возвращает `{ output }` без
 * `success` — поле обязательное, и без него тул выглядит упавшим. Считаем
 * отсутствие `success` успехом и приводим `output` к строке.
 */
export function wrapPluginHandler(handler: ToolDefinition["handler"]): ToolDefinition["handler"] {
  return async (ctx, args) => {
    const raw: unknown = await handler(ctx, args);
    const result = (typeof raw === "string" ? { output: raw } : raw ?? {}) as Partial<ToolResult>;
    const output =
      typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
    return { ...result, success: result.success !== false, output } as ToolResult;
  };
}

/** Тег плагина + `alwaysOn` по умолчанию: иначе `enable_tools` спрятал бы тул. */
export function withPluginMeta(plugin: string, name: string, def: ToolDefinition): ToolDefinition {
  const tag = pluginToolTag(plugin);
  const tags = [...(def.tags ?? [])];
  if (!tags.includes(tag)) tags.push(tag);
  // `name` — с префиксом плагина: в реестре определение лежит под своим ключом.
  return {
    ...def,
    name,
    tags,
    alwaysOn: def.alwaysOn ?? true,
    handler: wrapPluginHandler(def.handler),
  };
}

/** Замечание к одному определению: почему оно не годится. */
export function definitionProblem(def: ToolDefinition | undefined): string | null {
  if (!def || typeof def !== "object") return "not a tool definition";
  if (
    typeof def.name !== "string" ||
    !def.name.trim() ||
    typeof def.description !== "string" ||
    !def.parameters ||
    typeof def.parameters !== "object"
  ) {
    return "needs name, description and parameters";
  }
  if (typeof def.handler !== "function") return "needs a handler(ctx, args) returning {output}";
  return null;
}
