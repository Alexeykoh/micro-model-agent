/** Сборщик системного промпта: блоки по приоритету в бюджет токенов. */
import type { PromptBlock } from "./types";
import { estimateTokens } from "../llm/token-counter";

/** Диагностика блока: владелец, метка, приоритет, токены, вошёл ли в бюджет. */
export interface BlockBuildInfo {
  /** Владелец блока (INV-1/17), напр. `indexer`. */
  source?: string;
  label: string;
  priority: string;
  essential: boolean;
  tokens: number;
  included: boolean;
  /** Почему блок не вошёл или работает неполно (INV-17). */
  reason?: string;
}

/** Итог сборки: промпт, исключённое, разбивка по блокам для лога. */
export interface BuildResult {
  prompt: string;
  excluded: string[];
  /**
   * Невместившиеся блоки целиком — резолвер переполнения суммаризирует
   * из них instructions/project-map (agent.ts).
   */
  excludedBlocks: PromptBlock[];
  /** Поблочная разбивка — логирует реальный состав системного промпта. */
  blocks: BlockBuildInfo[];
}

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Убирает блоки, которым нужен неактивный тег тулов (напр. `browser`).
 * Пустой/неизвестный набор — legacy-режим «все тулы», блоки не фильтруются.
 */
export function filterBlocksForTags(
  blocks: PromptBlock[],
  activeTags: string[] | undefined,
): PromptBlock[] {
  if (!activeTags || activeTags.length === 0) return blocks;
  const active = new Set(activeTags);
  return blocks.filter(
    (block) => !block.requiresTags?.length || block.requiresTags.some((tag) => active.has(tag)),
  );
}

/**
 * Метка блока для лога: `владелец: имя` (`indexer: project map`), а не
 * обрезанная первая строка контента (INV-17). `label` блока приоритетнее
 * автовывода из контента.
 */
function blockLabel(block: PromptBlock): string {
  const owner = block.source ? `${block.source}: ` : "";
  const fallback = block.content.split("\n")[0].trim();
  const name = block.label?.trim() || fallback;
  const full = `${owner}${name}`;
  return full.length > 90 ? `${full.slice(0, 87)}...` : full;
}

/**
 * Заметка о блоках, выброшенных по бюджету (INV-6/17). `instructions` и
 * `project-map` обрабатывает резолвер переполнения отдельно — их не дублируем.
 * @param excludedBlocks блоки, не вошедшие в промпт.
 * @returns essential-блок с причиной или null, если сообщать нечего.
 */
export function omittedBlocksNote(excludedBlocks: PromptBlock[]): PromptBlock | null {
  const relevant = excludedBlocks.filter((block) => !block.kind);
  if (relevant.length === 0) return null;
  const lines = [`[Prompt note] Omitted due to the system-prompt budget:`];
  for (const block of relevant.slice(0, 5)) {
    lines.push(`- ${blockLabel(block)}: ${block.estimatedTokens} tok`);
  }
  if (relevant.length > 5) lines.push(`- +${relevant.length - 5} more`);
  const content = lines.join("\n");
  return {
    source: "core",
    label: "omitted blocks",
    content,
    priority: "high",
    essential: true,
    estimatedTokens: estimateTokens(content),
  };
}

/**
 * Собирает системный промпт из блоков: essential всегда, остальные по
 * приоритету, пока влезают в бюджет. Блоки с `tail` идут в конец — их
 * изменение не рвёт prefix-cache стабильных секций.
 */
export class PromptBuilder {
  private blocks: PromptBlock[] = [];
  private budget: number;

  constructor(budget: number) {
    this.budget = budget;
  }

  /**
   * Добавляет один блок.
   * @param block блок промпта с приоритетом и оценкой токенов.
   */
  addBlock(block: PromptBlock): void {
    this.blocks.push(block);
  }

  /**
   * Добавляет несколько блоков.
   * @param blocks массив блоков промпта.
   */
  addBlocks(blocks: PromptBlock[]): void {
    for (const b of blocks) {
      this.blocks.push(b);
    }
  }

  /**
   * Строит промпт: essential-блоки всегда, остальные по приоритету в бюджет.
   * @returns промпт, исключённое и поблочная разбивка.
   */
  build(): BuildResult {
    const essential = this.blocks.filter((block) => block.essential);
    const nonEssential = this.blocks
      .filter((block) => !block.essential)
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    // Стабильный префикс → per-turn → волатильный хвост. Essential-tail
    // (план) — последним: он меняется на каждом шаге.
    const ordered = [
      ...essential.filter((block) => !block.tail),
      ...nonEssential.filter((block) => !block.tail),
      ...nonEssential.filter((block) => block.tail),
      ...essential.filter((block) => block.tail),
    ];

    let usedTokens = 0;
    const included: string[] = [];
    const excluded: string[] = [];
    const excludedBlocks: PromptBlock[] = [];
    const blocks: BlockBuildInfo[] = [];

    for (const block of ordered) {
      const tokens = block.estimatedTokens;
      const fits = block.essential || usedTokens + tokens <= this.budget;
      let reason = block.degraded?.reason;
      if (fits) {
        included.push(block.content);
        usedTokens += tokens;
      } else {
        excluded.push(block.content);
        excludedBlocks.push(block);
        reason = `budget: ${tokens} tok did not fit`;
      }
      blocks.push({
        source: block.source,
        label: blockLabel(block),
        priority: block.priority,
        essential: block.essential,
        tokens,
        included: fits,
        reason,
      });
    }

    return {
      prompt: included.join("\n\n"),
      excluded,
      excludedBlocks,
      blocks,
    };
  }
}
