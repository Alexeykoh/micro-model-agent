import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { formatCost } from "../modules/pricing/prices";

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
  },
  flush: () => void,
): number {
  flush();
  if (result.success) {
    if (result.totalCost !== undefined && result.totalCost > 0) {
      console.log(pc.dim(`${t("repl.cost", { cost: formatCost(result.totalCost) })}`));
      if (result.costBreakdown && result.costBreakdown.length > 1) {
        const parts = result.costBreakdown.map(
          (e) => `${e.provider} ${formatCost(e.cost)}`,
        );
        console.log(pc.dim(`  ${t("repl.cost_breakdown", { breakdown: parts.join(", ") })}`));
      }
    } else if (result.totalTokens !== undefined && result.totalTokens > 0) {
      console.log(pc.dim(`${t("repl.tokens", { tokens: result.totalTokens })}`));
    }
    if (!result.text) {
      console.log(pc.yellow(t("cli.no_output")));
    }
    return 0;
  }
  console.error(`${t("error.prefix")}${result.error}`);
  return 1;
}
