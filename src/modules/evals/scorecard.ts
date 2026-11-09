/**
 * Evals scorecard (P0 Evals 1/2): агрегация cert-манифестов в
 * success-rate/сafety без обращений к врачу (чистая функция).
 * См. спеку `2026-11-09-evals-design.md`.
 */

export interface CertSuiteresult {
  id: string;
  title: string;
  status: "pass" | "fail" | "error" | "skip" | string;
  passed: number;
  of: number;
  error?: string;
}

export interface CertEntryLike {
  model: string;
  providerUrl: string;
  mmaVersion: string;
  certifiedAt: string;
  suite: { passed: number; failed: number; skipped: number; total: number };
  results: CertSuiteresult[];
}

export interface ScorecardModel {
  model: string;
  providerUrl: string;
  passed: number;
  failed: number;
  skipped: number;
  successRate: number;
  safetyFailures: number;
}

export interface EvalScorecard {
  models: ScorecardModel[];
  scenarios: number;
  passed: number;
  failed: number;
  skipped: number;
  successRate: number;
  safetyFailures: number;
}

const SAFETY_PREFIXES = ["security", "safety"];

function isSafetyScenario(id: string): boolean {
  return SAFETY_PREFIXES.some((p) => id.startsWith(p));
}

/** Агрегат cert-манифеста (bundled) в скоpковер. */
export function buildScorecard(entries: CertEntryLike[]): EvalScorecard {
  const models: ScorecardModel[] = entries.map((e) => {
    const safetyFailures = e.results.filter(
      (r) => isSafetyScenario(r.id) && (r.status === "fail" || r.status === "error"),
    ).length;
    const total = e.suite.total;
    return {
      model: e.model,
      providerUrl: e.providerUrl,
      passed: e.suite.passed,
      failed: e.suite.failed,
      skipped: e.suite.skipped,
      successRate: total > 0 ? e.suite.passed / total : 0,
      safetyFailures,
    };
  });

  const passed = models.reduce((n, m) => n + m.passed, 0);
  const failed = models.reduce((n, m) => n + m.failed, 0);
  const skipped = models.reduce((n, m) => n + m.skipped, 0);
  const total = passed + failed + skipped;
  const safetyFailures = models.reduce((n, m) => n + m.safetyFailures, 0);
  return {
    models,
    scenarios: entries.reduce((n, e) => n + e.results.length, 0),
    passed,
    failed,
    skipped,
    successRate: total > 0 ? passed / total : 0,
    safetyFailures,
  };
}
