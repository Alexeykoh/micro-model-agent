/**
 * Живое обновление инструкций (AGENTS.md) на границе хода.
 *
 * INV-1: у промпт-блока есть владелец (`source`), INV-6: обновлённый блок не
 * исчезает молча. Системный промпт имутабелен внутри хода ради KV-кеша —
 * поэтому файлы перечитываются ТОЛЬКО на границе хода (`turn-run.ts`), а не
 * на каждой итерации. Применяется замена на месте (`updateSystemPrompt`),
 * новое system-сообщение в историю не добавляется.
 */
import type { PromptBlock } from "./types";
import { loadAgentsMdBlocks } from "./bootstrap/state";
import { kindHash } from "./agent/prompt-blocks";

/** Результат сверки инструкций с диском. */
export interface InstructionRefreshResult {
  /** Новый массив блоков (при `changed: false` — тот же самый). */
  blocks: PromptBlock[];
  /** Изменилось ли содержимое хотя бы одного источника. */
  changed: boolean;
}

/** Отпечаток инструкций по `label` + хешу контента (порядок стабилен). */
export function instructionFingerprint(blocks: PromptBlock[]): string {
  return blocks
    .filter((b) => b.kind === "instructions")
    .map((b) => `${b.label}:${kindHash(b.content)}`)
    .sort()
    .join("|");
}

/**
 * Перечитывает AGENTS.md и заменяет instruction-блоки, сохраняя позиции
 * остальных блоков. Удалённые файлы убирают блок; новые — вставляются сразу
 * после последнего instruction-блока.
 *
 * @param baseDir workspace; @param configDir каталог конфига (глобальный AGENTS.md);
 * @param blocks текущие статические блоки; @returns новый массив и флаг изменения.
 */
export function refreshInstructionBlocks(
  baseDir: string,
  configDir: string | undefined,
  blocks: PromptBlock[],
): InstructionRefreshResult {
  // `--no-agents-md`: инструкций нет, обновлять нечего.
  if (!blocks.some((b) => b.kind === "instructions")) {
    return { blocks, changed: false };
  }
  if (!configDir) {
    return { blocks, changed: false };
  }

  const fresh = loadAgentsMdBlocks(baseDir, configDir, false);
  if (instructionFingerprint(blocks) === instructionFingerprint(fresh)) {
    return { blocks, changed: false };
  }

  const byLabel = new Map(fresh.map((b) => [b.label, b]));
  const next: PromptBlock[] = [];
  let lastInstructionIndex = -1;
  for (const block of blocks) {
    if (block.kind !== "instructions") {
      next.push(block);
      continue;
    }
    const replacement = byLabel.get(block.label);
    if (!replacement) continue;
    byLabel.delete(block.label);
    next.push(replacement);
    lastInstructionIndex = next.length - 1;
  }
  const added = [...byLabel.values()];
  if (added.length > 0) {
    const at = lastInstructionIndex >= 0 ? lastInstructionIndex + 1 : next.length;
    next.splice(at, 0, ...added);
  }
  return { blocks: next, changed: true };
}
