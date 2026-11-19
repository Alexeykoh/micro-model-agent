/**
 * Живое обновление инструкций (AGENTS.md) на границе хода.
 *
 * INV-1: у промпт-блока есть владелец (`source`), INV-6: обновлённый блок не
 * исчезает молча. Системный промпт имутабелен внутри хода ради KV-кеша —
 * поэтому файлы перечитываются ТОЛЬКО на границе хода (`turn-run.ts`), а не
 * на каждой итерации. Применяется замена на месте (`updateSystemPrompt`),
 * новое system-сообщение в историю не добавляется.
 */
import type { InstructionSourceChange, PromptBlock } from "./types";
import type { AppConfig } from "../config/types";
import { loadAgentsMdBlocks } from "./bootstrap/state";
import { kindHash } from "./agent/prompt-blocks";

/** Результат сверки инструкций с диском. */
export interface InstructionRefreshResult {
  /** Новый массив блоков (при `changed: false` — тот же самый). */
  blocks: PromptBlock[];
  /** Изменилось ли содержимое хотя бы одного источника. */
  changed: boolean;
  /** Отпечаток источников ПОСЛЕ обновления (для события в session.jsonl). */
  fingerprint: string;
  /** Что именно изменилось (без содержимого файлов). */
  changes: InstructionSourceChange[];
}

/** Карта «источник → хеш содержимого». */
function instructionMap(blocks: PromptBlock[]): Map<string, string> {
  return new Map(
    blocks
      .filter((b) => b.kind === "instructions")
      .map((b) => [b.label ?? "", kindHash(b.content)]),
  );
}

/** Отпечаток инструкций по `label` + хешу контента (порядок стабилен). */
export function instructionFingerprint(blocks: PromptBlock[]): string {
  return [...instructionMap(blocks)]
    .map(([label, hash]) => `${label}:${hash}`)
    .sort()
    .join("|");
}

/** Разница между двумя наборами источников. */
export function instructionChanges(
  before: PromptBlock[],
  after: PromptBlock[],
): InstructionSourceChange[] {
  const old = instructionMap(before);
  const next = instructionMap(after);
  const changes: InstructionSourceChange[] = [];
  for (const [label, hash] of next) {
    const previous = old.get(label);
    if (previous === undefined) changes.push({ label, action: "added" });
    else if (previous !== hash) changes.push({ label, action: "changed" });
  }
  for (const label of old.keys()) {
    if (!next.has(label)) changes.push({ label, action: "removed" });
  }
  return changes;
}

/** Пустой результат для случая, когда перечитывать нечего. */
function unchanged(blocks: PromptBlock[]): InstructionRefreshResult {
  return { blocks, changed: false, fingerprint: instructionFingerprint(blocks), changes: [] };
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
  config?: AppConfig,
  skip = false,
): InstructionRefreshResult {
  if (skip || !configDir) return unchanged(blocks);

  const fresh = loadAgentsMdBlocks(
    baseDir,
    configDir,
    skip,
    config?.instructions?.sources ?? [],
    config?.instructions?.fallback ?? "none",
  );
  if (instructionFingerprint(blocks) === instructionFingerprint(fresh)) return unchanged(blocks);

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
  return {
    blocks: next,
    changed: true,
    fingerprint: instructionFingerprint(next),
    changes: instructionChanges(blocks, next),
  };
}
