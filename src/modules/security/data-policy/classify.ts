/**
 * Классификатор: сводит находки всех детекторов в неперекрывающийся набор.
 * При пересечении приоритет: secret > path > machine/env > pii (длиннее/увереннее
 * выигрывает при равном приоритете).
 */
import type { PolicyContext } from "./context";
import type { DataClass, Finding } from "./types";
import { detectPaths } from "./detectors/paths";
import { detectMachine } from "./detectors/machine";
import { detectSecrets } from "./detectors/secrets";
import { detectPii } from "./detectors/pii";

const PRIORITY: Record<DataClass, number> = {
  secret: 5,
  path: 4,
  machine: 3,
  env: 3,
  "file-content": 3,
  pii: 2,
};

/** Отсортировать и снять перекрытия (детерминированный выбор победителя). */
export function dedupe(findings: readonly Finding[]): Finding[] {
  const sorted = [...findings].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const pa = PRIORITY[a.dataClass];
    const pb = PRIORITY[b.dataClass];
    if (pa !== pb) return pb - pa;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (la !== lb) return lb - la;
    return b.confidence - a.confidence;
  });

  const accepted: Finding[] = [];
  for (const f of sorted) {
    if (accepted.some((a) => f.start < a.end && a.start < f.end)) continue;
    accepted.push(f);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** Классифицировать текст: все находки, неперекрывающиеся, по возрастанию позиции. */
export function classify(text: string, ctx: PolicyContext): Finding[] {
  if (!text) return [];
  const all: Finding[] = [
    ...detectSecrets(text),
    ...detectPaths(text, ctx),
    ...detectMachine(text, ctx),
    ...detectPii(text),
  ];
  return dedupe(all);
}
