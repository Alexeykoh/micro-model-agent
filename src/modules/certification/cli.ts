import { rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";
import { loadScenarios, filterByTags, filterByScenarios, unknownScenarioIds } from "./loader";
import { runScenario, findMmaRoot } from "./runner";
import {
  readMergedManifest,
  upsertCertification,
  removeCertification,
  isFullyPassed,
} from "./manifest";
import type { AppConfig } from "../../config/types";
import type { CertTag, CertificationEntry, ScenarioResult, SuiteSummary } from "./types";
import { getDefaultChannel } from "../../output";

const HERE = dirname(fileURLToPath(import.meta.url));
const MMA_ROOT = findMmaRoot(HERE);

function readVersion(): string {
  const candidates = [join(MMA_ROOT, "package.json")];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        if (raw.version) return raw.version;
      } catch {
        // Broken package.json — fall back to the default version
      }
    }
  }
  return "0.0.0";
}

export function parseTags(s: string): CertTag[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean) as CertTag[];
}

export interface CertifyOptions {
  name: string;
  providerUrl?: string;
  providerKey?: string;
  contextWindow?: number;
  tags: CertTag[];
  reps: number;
  force: boolean;
  clean: boolean;
  /** Scenario ids to (re-)run; when set, only these scenarios run and the rest of an existing certification is preserved. */
  scenarios?: string[];
  /** Default per-rep timeout in ms (overridden by scenario.timeoutMs). */
  timeout?: number;
  config: AppConfig;
  projectDir: string;
}

export async function certify(opts: CertifyOptions): Promise<void> {
  const providerUrl = opts.providerUrl || opts.config.provider.baseUrl;

  const { scenarios, errors } = loadScenarios(
    join(opts.projectDir, ".mma", "certification", "scenarios"),
  );
  for (const e of errors) getDefaultChannel().writeLine(pc.yellow(`  ${e}`), "stderr");

  let selected = filterByTags(scenarios, opts.tags);
  const isPartial = Array.isArray(opts.scenarios) && opts.scenarios.length > 0;
  if (isPartial) {
    const unknown = unknownScenarioIds(scenarios, opts.scenarios!);
    if (unknown.length > 0) {
      getDefaultChannel().writeLine(
        pc.red(
          t("cli.cert_scenarios_unknown", {
            ids: unknown.join(", "),
            available: scenarios.map((s) => s.id).join(", "),
          }),
        ),
        "stderr",
      );
      process.exitCode = 1;
      return;
    }
    // A targeted re-run selects from ALL loaded scenarios (union of their
    // tags), not the tag-filtered subset — otherwise re-running a security
    // scenario with default core-only tags silently produced an empty
    // selection.
    selected = filterByScenarios(scenarios, opts.scenarios!);
  }
  if (selected.length === 0) {
    getDefaultChannel().writeLine(
      pc.red(t("cli.cert_no_scenarios", { tags: opts.tags.join(",") })),
      "stderr",
    );
    process.exitCode = 1;
    return;
  }

  const manifest = readMergedManifest(opts.projectDir);
  const existing = manifest.certifications.find(
    (e) => e.model === opts.name && e.providerUrl === providerUrl,
  );
  // A full-suite re-run overwrites the entry and requires --force; a partial
  // (scenario-targeted) run is an incremental update by definition.
  if (existing && !opts.force && !isPartial) {
    getDefaultChannel().writeLine(pc.yellow(t("cli.cert_exists", { model: opts.name })), "stderr");
    getDefaultChannel().writeLine(pc.yellow(t("cli.cert_exists_hint")), "stderr");
    process.exitCode = 1;
    return;
  }

  getDefaultChannel().writeLine(t("cli.cert_started", { model: opts.name, provider: providerUrl }));

  const sandboxBase = join(process.cwd(), ".mma", "certification");
  const results: ScenarioResult[] = [];
  const total = selected.length;
  let idx = 0;

  for (const scenario of selected) {
    idx++;
    if (scenario.mode === "skip") {
      getDefaultChannel().writeLine(pc.dim(`[${idx}/${total}] ${scenario.id} ... skipped`));
      results.push({
        id: scenario.id,
        title: scenario.title,
        status: "skipped",
        passed: 0,
        of: 0,
      });
      continue;
    }
    const res = await runScenario(scenario, {
      model: opts.name,
      providerUrl,
      providerKey: opts.providerKey,
      contextWindow: opts.contextWindow,
      mmaRoot: MMA_ROOT,
      sandboxBase,
      defaultReps: opts.reps,
      defaultThreshold: 2,
      timeoutMs: opts.timeout,
      baseConfig: opts.config,
      onRep: (id, rep, reps, passed, failures) => {
        const word = passed ? pc.green(t("cli.cert_rep_pass")) : pc.red(t("cli.cert_rep_fail"));
        getDefaultChannel().writeLine(`[${idx}/${total}] ${id} (${rep}/${reps})... ${word}`);
        if (!passed) getDefaultChannel().writeLine(`    ${pc.dim(failures.join("; "))}`);
      },
    });
    results.push(res);
  }

  if (opts.clean) {
    try {
      rmSync(sandboxBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  // Partial run: keep previous results for scenarios that were not re-run.
  const runIds = new Set(selected.map((s) => s.id));
  const finalResults =
    isPartial && existing ? mergePartialResults(results, existing.results, runIds) : results;

  const suite = summarize(finalResults);
  // Only a re-run that covers EVERY scenario in the suite may refresh
  // mmaVersion — a partial re-run leaves most results from an older MMA, so
  // stamping the current version would fake a fresh certification.
  const ranEntireSuite = scenarios.every((s) => runIds.has(s.id));
  const entry: CertificationEntry = {
    model: opts.name,
    providerUrl,
    mmaVersion: ranEntireSuite ? readVersion() : (existing?.mmaVersion ?? readVersion()),
    certifiedAt: new Date().toISOString(),
    suite,
    results: finalResults,
  };
  // Certifications are per (model, providerUrl) — machine-scoped, not
  // project-scoped: store them in the global manifest so marks follow the
  // user into any directory.
  upsertCertification(entry);

  getDefaultChannel().writeLine(
    t("cli.cert_done", {
      passed: String(suite.passed),
      failed: String(suite.failed),
      skipped: String(suite.skipped),
      total: String(suite.total),
    }),
  );
  printResults(finalResults);

  if (isFullyPassed(entry)) {
    getDefaultChannel().writeLine(pc.green(`\n✔ ${opts.name} is certified`));
  } else {
    getDefaultChannel().writeLine(
      pc.yellow(`\n⚠ ${opts.name} is NOT certified — all scenarios must pass`),
    );
  }

  // Always write report file
  writeReport(entry, opts.projectDir);
}

export async function certStatus(
  name: string,
  config: AppConfig,
  projectDir: string,
): Promise<void> {
  const m = readMergedManifest(projectDir);
  const providerUrl = config.provider.baseUrl;
  const entry = m.certifications.find((e) => e.model === name && e.providerUrl === providerUrl);
  if (!entry) {
    getDefaultChannel().writeLine(t("cli.cert_not_found", { model: name }));
    return;
  }
  getDefaultChannel().writeLine(`${t("cli.cert_provider_col")}: ${entry.providerUrl}`);
  getDefaultChannel().writeLine(
    `${t("cli.cert_version_col")}: ${entry.mmaVersion}  ${t("cli.cert_date_col")}: ${entry.certifiedAt.slice(0, 10)}`,
  );
  getDefaultChannel().writeLine(
    `${t("cli.cert_suite_col")}: ${entry.suite.passed} pass / ${entry.suite.failed} fail / ${entry.suite.skipped} skipped`,
  );
  const status = isFullyPassed(entry) ? pc.green("✔ certified") : pc.yellow("⚠ NOT certified");
  getDefaultChannel().writeLine(`Status: ${status}`);
  printResults(entry.results);
}

export async function certList(projectDir: string): Promise<void> {
  const m = readMergedManifest(projectDir);
  if (m.certifications.length === 0) {
    getDefaultChannel().writeLine(t("cli.cert_empty"));
    return;
  }
  for (const e of m.certifications) {
    const mark = isFullyPassed(e) ? pc.green("✔") : pc.red("✘");
    getDefaultChannel().writeLine(
      `  ${mark} ${e.model}  ${pc.dim(e.providerUrl)}  ${e.mmaVersion}  ${e.certifiedAt.slice(0, 10)}  ${e.suite.passed}/${e.suite.total} pass`,
    );
  }
}

export async function uncertify(
  name: string,
  config: AppConfig,
  projectDir: string,
): Promise<void> {
  const removed = removeCertification(name, config.provider.baseUrl, {
    projectDir,
  });
  if (removed.global || removed.project)
    getDefaultChannel().writeLine(t("cli.cert_uncertified", { model: name }));
  else getDefaultChannel().writeLine(t("cli.cert_not_found", { model: name }));
}

function summarize(results: ScenarioResult[]): SuiteSummary {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    total: results.length,
  };
}

/**
 * Merge a partial run's results with a previous certification: fresh results
 * replace old ones by scenario id; results for scenarios that were not re-run
 * are preserved verbatim.
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

function printResults(results: ScenarioResult[]): void {
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

function writeReport(entry: CertificationEntry, projectDir: string): void {
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
