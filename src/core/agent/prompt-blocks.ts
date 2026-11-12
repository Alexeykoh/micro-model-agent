/**
 * Сборка блоков системного промпта (B12/B16/B17).
 *
 * Вынесено из `prompt-phase.ts` (правило ≤300 строк): тег-гейт по реально
 * видимым тулам, override-подмены переполнения, плагинные блоки и отпечаток
 * входов резолва. Чистые функции — без состояния хоста.
 */
import { createHash } from "crypto";
import { filterBlocksForTags } from "../prompt-builder";
import type { PromptBlock } from "../types";
import type { AgentDeps } from "./deps";

/** Хеш контента kind-блока для отпечатка (B16: ловит правки любой длины). */
function kindHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Отпечаток входов резолва: бюджет плюс kind-блоки до override-подмен.
 * Подмены не входят намеренно — иначе каждый резолв менял бы отпечаток
 * и следующий прогон пересчитывал бы снова.
 */
export function overflowFingerprint(systemBudget: number, blocks: PromptBlock[]): string {
  const kinds = blocks
    .filter((b) => b.kind)
    .map((b) => `${b.kind}:${kindHash(b.content)}`)
    .sort()
    .join("|");
  return `${systemBudget}|${kinds}`;
}

/** Применяет сжатые резолвом замены по kind (B-overflow). */
export function applyOverrides(
  blocks: PromptBlock[],
  overrides: Map<string, PromptBlock>,
): PromptBlock[] {
  return blocks.map((b) => (b.kind && overrides.has(b.kind) ? overrides.get(b.kind)! : b));
}

/** Гейт блоков по активным и реально видимым тегам (B12, allowlist-aware). */
export function gateBlocks(deps: AgentDeps, blocks: PromptBlock[]): PromptBlock[] {
  const visibleTags = deps.toolExecutor?.getVisibleTags?.(deps.toolTags);
  return filterBlocksForTags(blocks, deps.toolTags, visibleTags);
}

/** Блоки плагинов из onBuildPrompt: непустые строки как low-блоки. */
export function pluginPromptBlocks(deps: AgentDeps, estimate: (s: string) => number): PromptBlock[] {
  return (deps.pluginManager.runOnBuildPrompt?.() ?? []).flatMap((content): PromptBlock[] =>
    content && content.trim() !== ""
      ? [
          {
            source: "plugin",
            label: "capabilities",
            content,
            priority: "low" as const,
            essential: false,
            estimatedTokens: estimate(content),
          },
        ]
      : [],
  );
}
