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
import {
  buildHiddenToolsBlock,
  buildToolContractBlock,
  hiddenToolCounts,
} from "../tools/hidden-tools-block";
import { estimateTokens } from "../llm/token-counter";

/** Входы сборки динамических блоков (main и раннер передают своё). */
export interface DynamicBlocksParams {
  /** Активная модель (блок идентичности). */
  model: string;
  skillsModule: {
    getSystemPromptBlock(): PromptBlock | null;
    getPromptBlocks?(): PromptBlock[];
  };
  /** Сессионный модуль — у раннера он свой (id/имя его сессии). */
  sessionModule: { getSystemPromptBlock(): PromptBlock | null };
  indexerModule: { getSystemPromptBlock(): PromptBlock | null };
  registry: ToolRegistry;
  /** Активные теги тулов (для блока скрытых тулов). */
  activeTags: string[];
  /** Онбординг-allowlist: сужает набор, блок скрытых тулов не показываем. */
  toolAllowlist?: string[];
  /** Per-session тумблеры: каталог и счётчики должны совпадать со схемой. */
  toolOverrides?: { enabled?: string[]; disabled?: string[] };
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
  const skillBlocks =
    p.skillsModule.getPromptBlocks?.() ??
    [p.skillsModule.getSystemPromptBlock()].filter((b): b is PromptBlock => Boolean(b));
  for (const block of skillBlocks) {
    blocks.push({ source: "skills", ...block });
  }
  const sessionBlock = p.sessionModule.getSystemPromptBlock();
  if (sessionBlock) blocks.push({ source: "session", ...sessionBlock });
  const mapBlock = p.indexerModule.getSystemPromptBlock();
  if (mapBlock) blocks.push({ source: "indexer", ...mapBlock });
  if (p.capabilitiesBlock) blocks.push(p.capabilitiesBlock);
  const hiddenToolsBlock = p.toolAllowlist
    ? null
    : buildHiddenToolsBlock(p.registry.getAll(), p.activeTags, p.toolOverrides);
  if (hiddenToolsBlock) {
    const counts = hiddenToolCounts(p.registry.getAll(), p.activeTags, p.toolOverrides);
    const contract = buildToolContractBlock(counts);
    // Контракт essential: даже если каталог вылетит по бюджету, модель знает,
    // что вызывать можно только схемы и как включить недостающий capability.
    blocks.push({
      source: "core",
      label: "tool contract",
      content: contract,
      priority: "high",
      essential: true,
      estimatedTokens: estimateTokens(contract),
    });
    blocks.push({
      source: "core",
      label: "locked tool catalog",
      content: hiddenToolsBlock,
      priority: "low",
      essential: false,
      estimatedTokens: estimateTokens(hiddenToolsBlock),
    });
  }
  return blocks;
}
