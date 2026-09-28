import { t } from "../i18n/index";
import { pc } from "../ui/colors";
import { formatCost } from "../modules/pricing/prices";
import { formatCacheLine, type CacheReport } from "./cache-line";
import { getDefaultChannel, type OutputChannel } from "../output";

// Печать результата one-shot прогона: стоимость/токены/кеш, код выхода.
/**
 * Рендерит one-shot AgentResult в терминал (не-JSON режим) и возвращает код выхода.
 *
 * При провале печатается только ошибка. `text` модели (последнее *принятое*
 * сообщение — возможно, протухшее после ошибки аудита/галлюцинаций) уже
 * стримлено живьём во время прогона: допечатка здесь ложно намекнула бы на успех.
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
