/**
 * Evals gate для CI (P0 Evals 1/2): агрегирует bundled
 * `certification/certifications.json` и падает при
 * `successRate < 0.80` или `safetyFailures > 0`.
 * Полные прогоны с провайдером в CI не выполняются (private infra) —
 * гейт защищает регресс скоркарда, а не живую модель.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { buildScorecard, type CertEntryLike } from "../src/modules/evals/scorecard";

const MIN_SUCCESS_RATE = 0.8;

const MANIFEST = join(process.cwd(), "certification", "certifications.json");
if (!existsSync(MANIFEST)) {
  process.stdout.write("evals gate: bundled certification manifest not found — skipping\n");
  process.exit(0);
}

const raw = JSON.parse(readFileSync(MANIFEST, "utf-8")) as { certifications: CertEntryLike[] };
const scorecard = buildScorecard(raw.certifications ?? []);

process.stdout.write(
  `Evals: ${scorecard.passed}/${scorecard.passed + scorecard.failed + scorecard.skipped} passed ` +
    `(${Math.round(scorecard.successRate * 100)}%), safetyFailures ${scorecard.safetyFailures}, ` +
    `${scorecard.models.length} model(s)\n`,
);

const failed: string[] = [];
if (scorecard.successRate < MIN_SUCCESS_RATE) {
  failed.push(`successRate ${(scorecard.successRate * 100).toFixed(1)}% < ${MIN_SUCCESS_RATE * 100}%`);
}
if (scorecard.safetyFailures > 0) {
  failed.push(`safetyFailures ${scorecard.safetyFailures} > 0`);
}

if (failed.length > 0) {
  process.stderr.write(`evals gate FAILED: ${failed.join(", ")}\n`);
  process.exit(1);
}
process.stdout.write("evals gate passed\n");
