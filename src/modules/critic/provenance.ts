/**
 * Провенанс вердикта критика (A6): `critical` без улики в перечисленных
 * критических жалобах понижается до `concern`.
 *
 * Причина: критик эскалировал числа/факты без ссылки на файл/команду/вывод,
 * и гейт тратил repair-цикл на утверждение, которое нечем проверить. Жалоба
 * всё равно доходит до модели (советом), но не открывает «критический» ремонт.
 *
 * Спека: `docs/specs/2026-11-03-critic-evidence-provenance-design.md`.
 */
import type { CriticIssue, CriticVerdict } from "./types";

/** Итог проверки провенанса: вердикт и признак понижения (для журнала). */
export interface ProvenanceResult {
  verdict: CriticVerdict;
  downgraded?: "no_evidence";
}

/** Улика в жалобе — непустое поле `evidence` (файл/команда/вывод). */
function hasEvidence(issue: CriticIssue): boolean {
  return (issue.evidence ?? "").trim().length > 0;
}

/** Понизить `critical` до `concern`, если критические жалобы без улик. */
export function withProvenance(verdict: CriticVerdict): ProvenanceResult {
  if (verdict.status !== "critical") return { verdict };
  const critical = verdict.issues.filter((i) => i.severity === "critical");
  // Вердикт без перечисленных жалоб («задача не выполнена» в summary) —
  // требование улики неприменимо; поведение не меняем.
  if (critical.length === 0) return { verdict };
  if (critical.some(hasEvidence)) return { verdict };
  return {
    verdict: {
      ...verdict,
      status: "concern",
      issues: verdict.issues.map((i) =>
        i.severity === "critical" ? { ...i, severity: "concern" as const } : i,
      ),
    },
    downgraded: "no_evidence",
  };
}
