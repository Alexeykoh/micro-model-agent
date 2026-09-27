import type { ContextManager } from "../../modules/context/manager";
import type { HallucinationDetector } from "../../modules/hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import { FORCED_COMPACTION_COOLDOWN, QUALITY_TRIGGER_THRESHOLD } from "./constants";

/**
 * Единая точка компакции контекста. В agent.ts логика дублировалась в 4 местах:
 * 1) интервал (needsCompaction) в начале итерации;
 * 2) принудительно по низкому качеству (< QUALITY_TRIGGER_THRESHOLD) с cooldown;
 * 3) принудительно по переполнению бюджета истории;
 * 4) после добавления результата тула.
 *
 * Все четыре консолидированы здесь и выполняют одинаковый контракт:
 * компакция → логирование в session log → обогащение детектора халлюцинаций
 * известными файлами из сводки.
 */
export class CompactionService {
  constructor(
    private readonly deps: {
      contextManager: ContextManager;
      logger: Logger;
      slog: SessionLogger;
      hallucinationDetector: HallucinationDetector;
    },
  ) {}

  /**
   * Пре-итерационные проверки: интервал → качество → переполнение.
   * Порядок сохранён из оригинального цикла: каждая следующая проверка
   * видит контекст уже ПОСЛЕ предыдущей компакции.
   */
  compactIfNeeded(state: LoopState): void {
    this.compactOnInterval(state.iteration);
    this.compactOnQuality(state);
    this.compactOnOverflow(state.iteration);
  }

  /** Проверка после добавления результата тула в контекст. */
  compactAfterTool(state: LoopState): void {
    const { contextManager } = this.deps;
    if (!contextManager.needsCompaction()) return;
    const result = contextManager.compact();
    if (!result) return;
    this.deps.logger.debug("Context compacted after tool result");
    this.deps.slog.logCompaction({ reason: "after_tool", iteration: state.iteration, ...result });
    this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
  }

  private compactOnInterval(iteration: number): void {
    const { contextManager } = this.deps;
    if (!contextManager.needsCompaction()) return;
    const result = contextManager.compact();
    if (!result) return;
    this.deps.logger.debug("Context compacted");
    this.deps.slog.logCompaction({ reason: "interval", iteration, ...result });
    this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
  }

  private compactOnQuality(state: LoopState): void {
    const { contextManager } = this.deps;
    const iteration = state.iteration;
    const quality = contextManager.getQuality();
    const cooldownElapsed =
      iteration - state.lastForcedCompactionIteration >= FORCED_COMPACTION_COOLDOWN;
    if (
      quality < QUALITY_TRIGGER_THRESHOLD &&
      contextManager.getCompactionCount() > 0 &&
      cooldownElapsed
    ) {
      state.lastForcedCompactionIteration = iteration;
      const result = contextManager.compact();
      if (!result) return;
      this.deps.logger.diagnostic(
        "warn",
        `Low context quality (${quality}%) — forced compaction`,
      );
      this.deps.slog.logCompaction({
        reason: `quality-triggered (${quality}% < ${QUALITY_TRIGGER_THRESHOLD}%)`,
        iteration,
        ...result,
      });
      this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
    }
  }

  private compactOnOverflow(iteration: number): void {
    const { contextManager } = this.deps;
    const currentTokens = contextManager.getEstimatedTokens();
    const budget = contextManager.getBudget();
    if (currentTokens <= budget.history) return;
    const result = contextManager.compact();
    if (!result) return;
    this.deps.logger.diagnostic(
      "warn",
      `Context overflow (${currentTokens} > ${budget.history}), forced compaction`,
    );
    this.deps.slog.logCompaction({
      reason: `overflow (${currentTokens} > ${budget.history})`,
      iteration,
      ...result,
    });
    this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
  }
}