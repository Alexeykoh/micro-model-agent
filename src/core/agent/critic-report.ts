/**
 * Свёрнутый отчёт о проверке критика для ленты: что смотрел, какие проверки
 * запросил и чем закончил. Вынесено из `critic-gate.ts` (правило ≤300).
 *
 * Сырых reasoning-токенов у критика нет (`reasoningEffort: none`), поэтому
 * «размышления» здесь — это проходы (вердикт → проверки → финал), аргументы
 * read-only проверок и итоговые жалобы. Оригиналов файлов и секретов нет.
 */
import { t } from "../../i18n/index";
import type { CriticReport, CriticReportCheck } from "../types";
import type { CriticStage, CriticVerdict } from "../../modules/critic/types";
import type { CriticGateDeps } from "./critic-contract";

/** Сколько проверок показывать в свёрнутом блоке (кап самого критика — 3). */
const MAX_REPORT_CHECKS = 3;

function clip(text: string | undefined, max: number): string | undefined {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Проверки из последнего события с результатами (или хотя бы с запросом). */
function reportChecks(stages: CriticStage[]): CriticReportCheck[] {
  const withResults = [...stages].reverse().find((s) => s.results && s.results.length > 0);
  const withChecks = [...stages].reverse().find((s) => s.checks && s.checks.length > 0);
  const source = withResults ?? withChecks;
  if (!source?.checks) return [];
  return source.checks.slice(0, MAX_REPORT_CHECKS).map((check, i) => {
    const result = withResults?.results?.[i];
    return {
      tool: check.tool,
      args: clip(JSON.stringify(check.args), 160),
      ...(result ? { ok: result.ok, output: clip(result.output, 240) } : {}),
    };
  });
}

/** Собирает отчёт по вердикту (или его отсутствию) и событиям проходов. */
export function buildCriticReport(
  verdict: CriticVerdict | null,
  stages: CriticStage[],
  durationMs: number,
  timedOut: boolean,
): CriticReport {
  const issues = (verdict?.issues ?? []).slice(0, 5).map((issue) => ({
    severity: issue.severity,
    claim: clip(issue.claim, 200) ?? "",
    ...(clip(issue.problem, 240) ? { problem: clip(issue.problem, 240) } : {}),
    ...(clip(issue.suggestion, 240) ? { suggestion: clip(issue.suggestion, 240) } : {}),
    ...(clip(issue.evidence, 240) ? { evidence: clip(issue.evidence, 240) } : {}),
  }));
  return {
    status: verdict?.status ?? "none",
    ...(clip(verdict?.summary, 240) ? { summary: clip(verdict?.summary, 240) } : {}),
    issues,
    checks: reportChecks(stages),
    passes: stages.reduce((max, s) => Math.max(max, s.pass), 0) || 1,
    durationMs,
    ...(timedOut ? { timedOut: true } : {}),
  };
}

/** Одна строка прогресса для терминала/ленты; `undefined` — событие не о том. */
export function criticStageLine(stage: CriticStage): string | undefined {
  if (stage.stage === "verdict" && !stage.verdict) {
    return t("ui.critic_stage.verdict");
  }
  if (stage.stage === "checks" && stage.checks && stage.checks.length > 0 && !stage.results) {
    const tools = [...new Set(stage.checks.map((c) => c.tool))].join(", ");
    return t("ui.critic_stage.checks", { count: String(stage.checks.length), tools });
  }
  if (stage.stage === "checks" && stage.results) {
    return t("ui.critic_stage.checks_done", { count: String(stage.results.length) });
  }
  if (stage.stage === "final" && !stage.verdict) return t("ui.critic_stage.final");
  return undefined;
}

/** Компактная строка итога (её видит терминал; детали — в `critic`-блоке). */
export function criticReportLine(report: CriticReport): string {
  const status =
    report.status === "none" ? t("ui.critic_status.none") : t(`ui.critic_status.${report.status}`);
  return t("ui.critic_report", {
    status,
    passes: String(report.passes),
    duration: `${(report.durationMs / 1000).toFixed(1)}s`,
  });
}

/** Эмит свёрнутого блока проверки (детали по умолчанию скрыты во всех режимах). */
export function emitCriticReport(deps: CriticGateDeps, report: CriticReport): void {
  deps.onMeta?.(`\n${criticReportLine(report)}\n`, "critic", {
    source: "critic",
    reason: report.summary,
    verdict: report.status,
    iteration: deps.iteration,
    critic: report,
  });
}
