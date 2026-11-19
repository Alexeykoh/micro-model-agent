// CLI-команды сертификации: прогон сценариев, статусы, список и снятие меток.
import { rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { projectMmaDir } from "../../config/paths";
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
import type { CertTag, CertificationEntry, ScenarioResult } from "./types";
import { getDefaultChannel } from "../../output";
import { summarize, printResults, writeReport, mergePartialResults } from "./cert-report";

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
        // Битый package.json — откат на версию по умолчанию
      }
    }
  }
  return "0.0.0";
}

/** Разбирает строку тегов через запятую в список `CertTag`. */
export function parseTags(s: string): CertTag[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean) as CertTag[];
}

/** Опции команды `certify`: модель, провайдер, выбор сценариев и повторы. */
export interface CertifyOptions {
  name: string;
  providerUrl?: string;
  providerKey?: string;
  contextWindow?: number;
  tags: CertTag[];
  reps: number;
  force: boolean;
  clean: boolean;
  /** Id сценариев для (пере-)прогона; когда заданы, гоняются только они, а остаток существующей сертификации сохраняется. */
  scenarios?: string[];
  /** Дефолтный таймаут одного повтора в мс (перекрывается полем `timeoutMs` сценария). */
  timeout?: number;
  config: AppConfig;
  projectDir: string;
}

/**
 * Прогоняет выбранные сценарии на модели и сохраняет запись в манифест.
 * Частичный прогон (по id) мержится с предыдущей записью.
 */
export async function certify(opts: CertifyOptions): Promise<void> {
  const providerUrl = opts.providerUrl || opts.config.provider.baseUrl;

  const { scenarios, errors } = loadScenarios(
    join(projectMmaDir(opts.projectDir), "certification", "scenarios"),
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
    // Точечный перепрогон выбирает из ВСЕХ загруженных сценариев (объединение
    // тегов), а не из отфильтрованного по тегам подмножества — иначе перепрогон
    // security-сценария с дефолтными core-тегами молча давал пустую выборку.
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
  // Полный перепрогон перезаписывает запись и требует --force; частичный
  // прогон (по id сценариев) по определению — инкрементальное обновление.
  if (existing && !opts.force && !isPartial) {
    getDefaultChannel().writeLine(pc.yellow(t("cli.cert_exists", { model: opts.name })), "stderr");
    getDefaultChannel().writeLine(pc.yellow(t("cli.cert_exists_hint")), "stderr");
    process.exitCode = 1;
    return;
  }

  getDefaultChannel().writeLine(t("cli.cert_started", { model: opts.name, provider: providerUrl }));

  const sandboxBase = join(projectMmaDir(process.cwd()), "certification");
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

  // Частичный прогон: сохраняем прежние результаты неперегнанных сценариев.
  const runIds = new Set(selected.map((s) => s.id));
  const finalResults =
    isPartial && existing ? mergePartialResults(results, existing.results, runIds) : results;

  const suite = summarize(finalResults);
  // Только прогон, покрывший ВСЕ сценарии набора, вправе обновить
  // mmaVersion — частичный оставляет большинство результатов от старого MMA,
  // и штамп текущей версии выдавал бы их за свежую сертификацию.
  const ranEntireSuite = scenarios.every((s) => runIds.has(s.id));
  const entry: CertificationEntry = {
    model: opts.name,
    providerUrl,
    mmaVersion: ranEntireSuite ? readVersion() : (existing?.mmaVersion ?? readVersion()),
    certifiedAt: new Date().toISOString(),
    suite,
    results: finalResults,
  };
  // Сертификации привязаны к паре (модель, providerUrl) — это машинный, а не
  // проектный скоуп: храним в глобальном манифесте, чтобы метки следовали
  // за пользователем в любой каталог.
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

  // Файл отчёта пишется всегда
  writeReport(entry, opts.projectDir);
}

/** Печатает статус сертификации модели (провайдер, версия, сводка, сценарии). */
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

/** Печатает все записи манифеста (модель, провайдер, версия, счёт). */
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

/** Удаляет запись о сертификации модели из глобального и проектного манифестов. */
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

// Печать/сводка/отчёт — в `./cert-report`.
export { mergePartialResults } from "./cert-report";
