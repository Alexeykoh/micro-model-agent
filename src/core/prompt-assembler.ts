/**
 * Единый сборщик динамических промпт-блоков (INV-16).
 *
 * До W1.5 сборка была продублирована (`collectDynamicPromptBlocks` в bootstrap и
 * `buildRunnerDynamicBlocks` в раннере) и **разошлась**: в раннере не было
 * блока возможностей плагинов. Здесь — одна функция; вызывающие передают свои
 * зависимости (у раннера свой `PluginManager`), а структура блоков едина.
 */
import type { PromptBlock } from "./types";
import type { ToolRegistry } from "../tools/registry";
import { buildModelBlock } from "./system-prompt";
import { buildHiddenToolsBlock } from "../tools/hidden-tools-block";
import { estimateTokens } from "../llm/token-counter";

/** Входы сборки динамических блоков (main и раннер передают своё). */
export interface DynamicBlocksParams {
  /** Активная модель (блок идентичности). */
  model: string;
  skillsModule: { getSystemPromptBlock(): PromptBlock | null };
  /** Сессионный модуль — у раннера он свой (id/имя его сессии). */
  sessionModule: { getSystemPromptBlock(): PromptBlock | null };
  indexerModule: { getSystemPromptBlock(): PromptBlock | null };
  registry: ToolRegistry;
  /** Активные теги тулов (для блока скрытых тулов). */
  activeTags: string[];
  /** Онбординг-allowlist: сужает набор, блок скрытых тулов не показываем. */
  toolAllowlist?: string[];
  /** Блок возможностей плагинов — считает вызывающий (свой pluginManager). */
  capabilitiesBlock?: PromptBlock | null;
}

/**
 * Собирает динамические блоки: модель → skills → session → project map →
 * возможности плагинов → скрытые тулы.
 * @param p входы сборки.
 * @returns список блоков в стабильном порядке.
 */
export function assembleDynamicPromptBlocks(p: DynamicBlocksParams): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  // Идентичность активной модели — динамическая (переживает смену модели).
  blocks.push(buildModelBlock(p.model));
  const skillsBlock = p.skillsModule.getSystemPromptBlock();
  if (skillsBlock) blocks.push({ source: "skills", ...skillsBlock });
  const sessionBlock = p.sessionModule.getSystemPromptBlock();
  if (sessionBlock) blocks.push({ source: "session", ...sessionBlock });
  const mapBlock = p.indexerModule.getSystemPromptBlock();
  if (mapBlock) blocks.push({ source: "indexer", ...mapBlock });
  if (p.capabilitiesBlock) blocks.push(p.capabilitiesBlock);
  const hiddenToolsBlock = p.toolAllowlist
    ? null
    : buildHiddenToolsBlock(p.registry.getAll(), p.activeTags);
  if (hiddenToolsBlock) {
    blocks.push({
      source: "core",
      label: "hidden tools",
      content: hiddenToolsBlock,
      priority: "low",
      essential: false,
      estimatedTokens: estimateTokens(hiddenToolsBlock),
    });
  }
  return blocks;
}
