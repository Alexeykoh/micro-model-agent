/**
 * Текстовые помощники вентиля критика: рендер жалоб и детект повтора.
 * Вынесено из `critic-gate.ts` (правило ≤300).
 */
import type { CriticIssue } from "../../modules/critic/types";
import { normalizedSignature } from "../../modules/critic/issue-key";
import type { LoopState } from "./loop-state";

/** Жалобы вердикта одной строкой (- [severity] problem → suggestion), до 5. */
export function renderIssues(issues: CriticIssue[]): string {
  return issues
    .slice(0, 5)
    .map(
      (i) => `- [${i.severity}] ${i.problem || i.claim}${i.suggestion ? ` → ${i.suggestion}` : ""}`,
    )
    .join("\n");
}

/**
 * True, если вердикт повторяет уже виденные жалобы (вплоть до перефраза
 * на уровне регистра/пунктуации). Вызывать ДО takeFreshIssues.
 */
export function isRepeatedVerdict(state: LoopState, issues: CriticIssue[]): boolean {
  return (
    issues.length > 0 && issues.every((i) => state.seenCriticIssues.has(normalizedSignature(i)))
  );
}
