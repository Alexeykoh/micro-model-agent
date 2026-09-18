import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { formatCost } from "../modules/pricing/prices";
import { formatCacheLine, type CacheReport } from "./cache-line";
import { getDefaultChannel, type OutputChannel } from "../output";

/**
 * Render a single-run AgentResult to the terminal (non-JSON mode) and return
 * the process exit code.
 *
 * On failure only the error is printed. The model's `text` (which is the last
 * *accepted* message, i.e. possibly stale after an audit/hallucination error)
 * was already streamed live during the run — re-printing it here misleadingly
 * suggests the task succeeded.
 */
export function printRunResult(
  result: {
    success: boolean;
    text?: string;
    error?: string;
    totalCost?: number;
    costBreakdown?: Array<{ provider: string; cost: number }>;
    totalTokens?: number;
    cache?: CacheReport;
  },
  flush: () => void,
  channel: OutputChannel = getDefaultChannel(),
): number {
  flush();
  if (result.success) {
    if (result.totalCost !== undefined && result.totalCost > 0) {
      channel.writeLine(pc.dim(`${t("repl.cost", { cost: formatCost(result.totalCost) })}`));
      if (result.costBreakdown && result.costBreakdown.length > 1) {
        const parts = result.costBreakdown.map((e) => `${e.provider} ${formatCost(e.cost)}`);
        channel.writeLine(pc.dim(`  ${t("repl.cost_breakdown", { breakdown: parts.join(", ") })}`));
      }
    } else if (result.totalTokens !== undefined && result.totalTokens > 0) {
      channel.writeLine(pc.dim(`${t("repl.tokens", { tokens: result.totalTokens })}`));
    }
    const cacheLine = formatCacheLine(result.cache);
    if (cacheLine) {
      channel.writeLine(pc.dim(`  ${cacheLine}`));
    }
    if (!result.text) {
      channel.writeLine(pc.yellow(t("cli.no_output")));
    }
    return 0;
  }
  channel.writeLine(`${t("error.prefix")}${result.error}`, "stderr");
  return 1;
}
