import { pc } from "../../ui/colors";
import type { UiConfig } from "../../config/types";
import type { ContextManager } from "../../modules/context/manager";
import type { OnMeta } from "../types";

/**
 * Рендер UI-индикаторов контекста (stats-бар и уведомление о компакции).
 *
 * Вынесен из agent.ts, где рендеринг жил прямо в бизнес-логике цикла.
 * `lastCompactionShown` хранится внутри и переживает несколько запусков
 * цикла (как исходное поле Agent) — экземпляр должен быть полем класса,
 * а не создаваться заново на каждый ход.
 */
export class ContextRenderer {
  private lastCompactionShown = 0;

  render(ui: UiConfig | undefined, contextManager: ContextManager, onMeta?: OnMeta): void {
    if (ui?.showContextStats) {
      this.renderStats(contextManager, onMeta);
    } else if (ui?.showCompaction) {
      this.renderCompaction(contextManager, onMeta);
    }
  }

  private renderStats(contextManager: ContextManager, onMeta?: OnMeta): void {
    const ctxTokens = contextManager.getEstimatedTokens();
    const ctxBudget = contextManager.getBudget();
    const ctxPct = Math.min(100, Math.round((ctxTokens / ctxBudget.history) * 100));
    const barLen = 10;
    const filled = Math.round((ctxPct / 100) * barLen);
    const ctxBar = pc.green("█".repeat(filled)) + pc.dim("░".repeat(barLen - filled));
    const pctColor = ctxPct >= 75 ? pc.yellow : pc.dim;
    const compCount = contextManager.getCompactionCount();
    const quality = contextManager.getQuality();
    const qualityColor = quality >= 70 ? pc.green : quality >= 40 ? pc.yellow : pc.red;
    onMeta?.(
      `\n  ${ctxBar}  ${pctColor(`${ctxPct}%`)}  ${pc.dim(`ctx: ${ctxTokens}/${ctxBudget.history}`)}  ${pc.dim(`compactions: ${compCount}`)}  ${qualityColor(`quality: ${quality}%`)}\n`,
    );
  }

  private renderCompaction(contextManager: ContextManager, onMeta?: OnMeta): void {
    const compCount = contextManager.getCompactionCount();
    if (compCount > this.lastCompactionShown) {
      this.lastCompactionShown = compCount;
      onMeta?.(pc.dim(`\n  ⟳ Context compacted (${compCount})\n`));
    }
  }
}