import { rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { t } from "../../i18n/index";
import { pc } from "../../ui/colors";
import { loadScenarios, filterByTags } from "./loader";
import { runScenario, findMmaRoot } from "./runner";
import { readManifest, upsertCertification, removeCertification } from "./manifest";
import type { AppConfig } from "../../config/types";
import type { CertTag, CertificationEntry, ScenarioResult, SuiteSummary } from "./types";

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
  config: AppConfig;
  projectDir: string;
}

export async function certify(opts: CertifyOptions): Promise<void> {
  const providerUrl = opts.providerUrl || opts.config.provider.baseUrl;

  const { scenarios, errors } = loadScenarios(join(opts.projectDir, ".mma", "certification", "scenarios"));
  for (const e of errors) console.error(pc.yellow(`  ${e}`));

  const selected = filterByTags(scenarios, opts.tags);
  if (selected.length === 0) {
    console.error(pc.red(t("cli.cert_no_scenarios", { tags: opts.tags.join(",") })));
    process.exitCode = 1;
    return;
  }

  const manifest = readManifest(opts.projectDir);
  const existing = manifest.certifications.find(
    (e) => e.model === opts.name && e.providerUrl === providerUrl,
  );
  if (existing && !opts.force) {
    console.error(pc.yellow(t("cli.cert_exists", { model: opts.name })));
    console.error(pc.yellow(t("cli.cert_exists_hint")));
    process.exitCode = 1;
    return;
  }

  console.log(t("cli.cert_started", { model: opts.name, provider: providerUrl }));

  const sandboxBase = join(process.cwd(), ".mma", "certification");
  const results: ScenarioResult[] = [];
  const total = selected.length;
  let idx = 0;

  for (const scenario of selected) {
    idx++;
    if (scenario.mode === "skip") {
      console.log(pc.dim(`[${idx}/${total}] ${scenario.id} ... skipped`));
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
      baseConfig: opts.config,
      onRep: (id, rep, reps, passed, failures) => {
        const word = passed ? pc.green(t("cli.cert_rep_pass")) : pc.red(t("cli.cert_rep_fail"));
        console.log(`[${idx}/${total}] ${id} (${rep}/${reps})... ${word}`);
        if (!passed) console.log(`    ${pc.dim(failures.join("; "))}`);
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

  const suite = summarize(results);
  const entry: CertificationEntry = {
    model: opts.name,
    providerUrl,
    mmaVersion: readVersion(),
    certifiedAt: new Date().toISOString(),
    suite,
    results,
  };
  upsertCertification(entry, opts.projectDir);

  console.log(
    t("cli.cert_done", {
      passed: String(suite.passed),
      failed: String(suite.failed),
      skipped: String(suite.skipped),
      total: String(suite.total),
    }),
  );
  printResults(results);
}

export async function certStatus(name: string, config: AppConfig, projectDir: string): Promise<void> {
  const m = readManifest(projectDir);
  const providerUrl = config.provider.baseUrl;
  const entry = m.certifications.find((e) => e.model === name && e.providerUrl === providerUrl);
  if (!entry) {
    console.log(t("cli.cert_not_found", { model: name }));
    return;
  }
  console.log(`${t("cli.cert_provider_col")}: ${entry.providerUrl}`);
  console.log(
    `${t("cli.cert_version_col")}: ${entry.mmaVersion}  ${t("cli.cert_date_col")}: ${entry.certifiedAt.slice(0, 10)}`,
  );
  console.log(
    `${t("cli.cert_suite_col")}: ${entry.suite.passed} pass / ${entry.suite.failed} fail / ${entry.suite.skipped} skipped`,
  );
  printResults(entry.results);
}

export async function certList(projectDir: string): Promise<void> {
  const m = readManifest(projectDir);
  if (m.certifications.length === 0) {
    console.log(t("cli.cert_empty"));
    return;
  }
  for (const e of m.certifications) {
    console.log(
      `  ${pc.green("✔")} ${e.model}  ${pc.dim(e.providerUrl)}  ${e.mmaVersion}  ${e.certifiedAt.slice(0, 10)}  ${e.suite.passed}/${e.suite.total} pass`,
    );
  }
}

export async function uncertify(name: string, config: AppConfig, projectDir: string): Promise<void> {
  const removed = removeCertification(name, config.provider.baseUrl, projectDir);
  if (removed) console.log(t("cli.cert_uncertified", { model: name }));
  else console.log(t("cli.cert_not_found", { model: name }));
}

function summarize(results: ScenarioResult[]): SuiteSummary {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    total: results.length,
  };
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
    console.log(`  ${icon} ${r.id}  ${detail}`);
    if (r.error) console.log(`    ${pc.dim(r.error)}`);
  }
}
