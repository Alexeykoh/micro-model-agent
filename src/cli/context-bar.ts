/**
 * Хвост хода в CLI: бар контекста/стоимости и одна строка о DLP-редакции.
 * Вынесено из `repl.ts` (правило 6: файл на потолке), поведение не менялось.
 */
import pc from "picocolors";
import { t } from "../i18n/index";
import { formatCost } from "../modules/pricing/prices";
import { takePassiveEgress } from "../modules/security/data-policy/turn-journal";
import type { SessionManager } from "../modules/session/manager";
import type { OutputChannel } from "../output";
import { formatCacheLine, type CacheReport } from "./cache-line";
import type { AppConfig } from "../config/types";

/** Рендерит бар использования контекста с компакциями и качеством. */
export function formatContextBar(
  used: number,
  limit: number,
  compactions?: number,
  quality?: number,
): string {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const barLen = 20;
  const filled = Math.round((pct / 100) * barLen);
  const bar = pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
  const pctStr = pct >= 75 ? pc.yellow(`${pct}%`) : pc.dim(`${pct}%`);
  let line = `  ${bar}  ${pctStr}  ${pc.dim(`(${used} / ${limit} tokens)`)}`;
  if (compactions !== undefined) {
    line += pc.dim(`  compactions: ${compactions}`);
  }
  if (quality !== undefined) {
    const qColor = quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
    line += `  ${qColor(`quality: ${quality}%`)}`;
  }
  return line;
}

/** Поля итога хода, нужные хвосту. */
export interface ContextBarResult {
  contextUsed?: number;
  contextLimit?: number;
  compactionCount?: number;
  contextQuality?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  totalCost?: number;
  cache?: CacheReport;
}

/** Зависимости рендера: канал, UI-настройки и состояние «уже показали». */
export interface ContextBarDeps {
  output: OutputChannel;
  ui: AppConfig["ui"];
  lastCompactionShown: number;
  result: ContextBarResult;
}

/** Нарисовать хвост хода; возвращает новое `lastCompactionShown`. */
export function renderContextBar(deps: ContextBarDeps): number {
  const { output, ui, result } = deps;
  if (
    result.contextUsed === undefined ||
    result.contextLimit === undefined ||
    result.contextLimit <= 0
  ) {
    return deps.lastCompactionShown;
  }

  let lastCompactionShown = deps.lastCompactionShown;
  if (ui?.showContextStats) {
    output.writeLine("");
    const ctxLine = formatContextBar(
      result.contextUsed,
      result.contextLimit,
      result.compactionCount,
      result.contextQuality,
    );
    output.writeLine(ctxLine);
    if (result.totalTokens !== undefined && result.totalTokens > 0) {
      const apiLine = pc.dim(
        t("repl.api_line", {
          prompt: String(result.promptTokens),
          completion: String(result.completionTokens),
          total: String(result.totalTokens),
        }),
      );
      output.writeLine(apiLine);
    }
    if (result.totalCost !== undefined && result.totalCost > 0) {
      output.writeLine(pc.yellow(`  ${t("repl.cost", { cost: formatCost(result.totalCost) })}`));
    }
    const cacheLine = formatCacheLine(result.cache);
    if (cacheLine) output.writeLine(pc.dim(`  ${cacheLine}`));
  } else if (ui?.showCompaction && result.compactionCount !== undefined) {
    if (result.compactionCount > lastCompactionShown) {
      lastCompactionShown = result.compactionCount;
      output.writeLine(
        pc.dim(`\n  ⟳ ${t("repl.compacted", { count: String(result.compactionCount) })}`),
      );
    }
  }
  return lastCompactionShown;
}

/**
 * Одна строка о DLP-редакции за ход (бывший долг `dlp-cli-redaction-notice`).
 * STYLE: без панелей, один глиф, quiet by default — при чистом ходе молчим.
 * В web этой строки нет: там бейдж DLP у ответа.
 */
export function reportDlpRedactions(output: OutputChannel, sessions?: SessionManager): void {
  const sid = sessions?.getActiveMeta()?.id;
  if (!sid) return;
  const summary = takePassiveEgress(sid);
  if (!summary || summary.total === 0) return;
  const classes = Object.keys(summary.stats)
    .filter((k) => (summary.stats[k as keyof typeof summary.stats] ?? 0) > 0)
    .map((k) => t(`web.dlp.class.${k}`))
    .join(", ");
  output.writeLine(pc.dim(`  ◇ ${t("ui.dlp_redacted", { count: summary.total, classes })}`));
}
