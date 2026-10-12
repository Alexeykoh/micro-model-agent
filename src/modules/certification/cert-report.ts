// Печать сертификации: сводка, отчёт и результаты — вынесено из `cli.ts`
// (правило ≤300).
import { writeFileSync } from "fs";
import { join } from "path";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";
import { isFullyPassed } from "./manifest";
import { getDefaultChannel } from "../../output";
import type { CertificationEntry, ScenarioResult, SuiteSummary } from "./types";

export function summarize(results: ScenarioResult[]): SuiteSummary {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    total: results.length,
  };
}

/**
 * Сливает результаты частичного прогона с прежней сертификацией: свежие
 * заменяют старые по id сценария; неперегнанные сохраняются как есть.
 */
export function mergePartialResults(
  fresh: ScenarioResult[],
  previous: ScenarioResult[],
  rerunIds: Set<string>,
): ScenarioResult[] {
  const preserved = previous.filter((r) => !rerunIds.has(r.id));
  if (preserved.length > 0) {
    getDefaultChannel().writeLine(
      pc.dim(t("cli.cert_partial_merge", { kept: String(preserved.length) })),
    );
  }
  return [...fresh, ...preserved];
}

export function printResults(results: ScenarioResult[]): void {
  for (const r of results) {
    const icon =
      r.status === "pass"
        ? pc.green("✔")
        : r.status === "fail"
          ? pc.red("✘")
          : r.status === "skipped"
            ? pc.dim("–")
            : pc.yellow("!");
    const detail = r.status === "skipped" ? pc.dim(r.title) : `${r.passed}/${r.of}`;
    getDefaultChannel().writeLine(`  ${icon} ${r.id}  ${detail}`);
    if (r.error) getDefaultChannel().writeLine(`    ${pc.dim(r.error)}`);
    if (r.diagnostics) getDefaultChannel().writeLine(r.diagnostics);
  }
}

export function writeReport(entry: CertificationEntry, projectDir: string): void {
  const reportDir = join(projectDir, "certification");
  const ts = entry.certifiedAt.replace(/[:.]/g, "-").slice(0, 19);
  const filename = `report-${entry.model.replace(/[/\\:]/g, "_")}-${ts}.json`;
  const reportPath = join(reportDir, filename);

  const report = {
    model: entry.model,
    providerUrl: entry.providerUrl,
    mmaVersion: entry.mmaVersion,
    certifiedAt: entry.certifiedAt,
    certified: isFullyPassed(entry),
    suite: entry.suite,
    results: entry.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      passed: r.passed,
      of: r.of,
      error: r.error,
      diagnostics: r.diagnostics,
    })),
  };

  try {
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    getDefaultChannel().writeLine(pc.dim(`\nReport: ${reportPath}`));
  } catch (e: any) {
    getDefaultChannel().writeLine(pc.yellow(`  Failed to write report: ${e.message}`), "stderr");
  }
}
