// Ключи дедупликации жалоб критика и заглушка issue'а.
//
// Вынесено из `core/agent/critic-gate.ts` (файл на пределе ≤300 строк).
import type { CriticIssue, CriticVerdict } from "./types";

/**
 * Грубая нормализация жалобы для ловли near-identical повторов (регистр,
 * пунктуация, пробелы). Настоящие перефразы («ran weather searches» vs
 * «ignored the task») этим не ловятся.
 *
 * Единственный ключ дедупликации: и повтор-детектор, и набор «уже виденных»
 * используют его, иначе «повтор» и «свежая жалоба» разойдутся (INV-C2).
 */
export function normalizedSignature(issue: CriticIssue): string {
  const body = `${issue.severity}:${issue.claim}`
    .toLowerCase()
    .replace(/[^a-z0-9а-яё\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `~${body}`;
}

/**
 * Issue-заглушка для вердикта без распарсенных `issues`: статус и сводка
 * модели — достаточное основание для действия. Раньше такой вердикт
 * исчезал молча («pass» без записи в лог) — INV-C2.
 */
export function syntheticIssue(verdict: CriticVerdict): CriticIssue {
  const text = verdict.summary.trim() || `critic reported ${verdict.status}`;
  return {
    severity: verdict.status === "critical" ? "critical" : "concern",
    claim: text,
    problem: text,
  };
}
