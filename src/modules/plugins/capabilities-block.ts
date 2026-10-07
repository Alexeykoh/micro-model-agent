// Промпт-блок `[Plugin capabilities]`: что умеют плагины и что агент может
// дописать себе сам.
//
// Блок появляется, когда есть хотя бы один плагинский тул (включая
// `define_capability` в наборе), иначе он был бы шумом: упоминать «можешь
// написать себе тул» модели, у которой нет тула `define_capability`, незачем.
import type { PluginManager } from "./manager";
import type { PromptBlock } from "../../core/types";
import { estimateTokens } from "../../llm/token-counter";

/** Имя тула, который пишет capability (в наборе он всегда, но не alwaysOn). */
const DEFINE_TOOL = "define_capability";

export interface PluginCapabilitiesInput {
  pluginManager: PluginManager;
  /** Виден ли модели тулы плагинов (набор не сужен дочерним allowlist'ом). */
  pluginsVisible: boolean;
}

/**
 * Список доступных capabilities: `плагин → тулы`. Плагины без тулов не
 * упоминаются — пользователя интересуют именно capabilities, а не хуки.
 */
export function formatCapabilities(pluginManager: PluginManager): string {
  const lines: string[] = [];
  for (const record of pluginManager.getRecords()) {
    if (!record.enabled || record.provides.tools.length === 0) continue;
    lines.push(`  ${record.name}: ${record.provides.tools.join(", ")}`);
  }
  return lines.join("\n");
}

/** Блок для системного промпта или null, когда показывать нечего. */
export function pluginCapabilitiesBlock(input: PluginCapabilitiesInput): PromptBlock | null {
  if (!input.pluginsVisible) return null;
  const capabilities = formatCapabilities(input.pluginManager);
  const content = [
    "[PLUGIN CAPABILITIES]",
    capabilities
      ? `Tools added by installed plugins (use them instead of reinventing):\n${capabilities}`
      : "No plugin tools installed yet.",
    "",
    "You can add a tool of your own with " + DEFINE_TOOL + ": it writes a draft capability",
    "into .mma/plugins/drafts/ and asks the user to approve running that code. Drafts",
    "never run without approval, so say plainly what the tool is for and declare its",
    "permissions. Do not write a capability when an existing tool already does the job.",
  ].join("\n");
  return {
    content,
    priority: "low",
    essential: false,
    estimatedTokens: estimateTokens(content),
  };
}
