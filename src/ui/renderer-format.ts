// Строковые строители шапки/футера карточки тула (шов `renderer.ts`).
import { formatCost } from "../modules/pricing/prices";
import { pc } from "./colors";
import { formatDuration, toolAccent } from "./theme";

export function formatUsd(cost: number): string {
  return formatCost(cost);
}

/** Шапка действия: `<mark> <акцентный ярлык> · <сводка>`. */
export function actionHead(
  mark: string,
  tool: string,
  label: string,
  summary: string,
): string {
  const accent = toolAccent(tool);
  return `${mark} ${accent(label)}${summary ? ` ${pc.dim("·")} ${pc.dim(summary)}` : ""}`;
}

/** Хвост футера: маркер, длительность, необязательные `ctx`/`cost`. */
export function footerTail(
  mark: string,
  duration: number,
  ctxDelta?: number,
  costUsd?: number,
): string {
  let tail = `${mark} ${pc.dim(formatDuration(duration))}`;
  if (ctxDelta !== undefined && ctxDelta !== 0) {
    const deltaStr = ctxDelta > 0 ? pc.green(`+${ctxDelta}`) : pc.yellow(`${ctxDelta} ↓`);
    tail += `  ${pc.dim("ctx")} ${deltaStr}`;
  }
  if (costUsd !== undefined && costUsd > 0) {
    tail += `  ${pc.dim("cost")} ${pc.yellow(formatUsd(costUsd))}`;
  }
  return tail;
}
