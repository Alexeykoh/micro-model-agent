/** Компакция контекста: единая точка всех триггеров цикла. */
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
 * Политика `legacy` воспроизводит поведение 2.18.2 (все четыре триггера
 * независимо). Политика `v2` (дефолт) добавляет канонический порог по истории,
 * cooldown переполнения, гарантию прогресса и один триггер на итерацию.
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

  /** Политика v2 для текущего менеджера. */
  private isV2(): boolean {
    return this.deps.contextManager.getPolicy?.() === "v2";
  }

  /**
   * Пре-итерационные проверки. В legacy порядок сохранён из оригинала
   * (интервал → качество → переполнение). В v2 выполняется не более одного
   * триггера за итерацию с приоритетом overflow.
   */
  compactIfNeeded(state: LoopState): void {
    if (!this.isV2()) {
      this.compactOnInterval(state.iteration);
      this.compactOnQuality(state);
      this.compactOnOverflow(state.iteration);
      return;
    }
    this.compactIfNeededV2(state);
  }

  /** Проверка после добавления результата тула в контекст. */
  compactAfterTool(state: LoopState): void {
    const { contextManager } = this.deps;
    if (this.isV2()) {
      // Лёгкий pre-check: не компактим здесь, только выставляем флаг на старт
      // следующей итерации (один триггер на итерацию).
      if (contextManager.needsCompaction()) state.pendingCompaction = true;
      return;
    }
    if (!contextManager.needsCompaction()) return;
    const result = contextManager.compact();
    if (!result) return;
    this.deps.logger.debug("Context compacted after tool result");
    this.deps.slog.logCompaction({ reason: "after_tool", iteration: state.iteration, ...result });
    this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
  }

  // ── v2 ────────────────────────────────────────────────────────────────────

  private compactIfNeededV2(state: LoopState): void {
    // 1) Overflow — канонический порог по истории (калиброванная оценка),
    //    cooldown и safety-clamp от неправдоподобного скачка.
    if (this.tryOverflowV2(state)) return;
    // 2) Один из оставшихся триггеров: pending (после тула), качество, интервал.
    this.tryFallbackV2(state);
  }

  /** Overflow-триггер v2 с cooldown и safety-clamp. True — компакция прошла. */
  private tryOverflowV2(state: LoopState): boolean {
    const { contextManager } = this.deps;
    const cooldown = contextManager.getOverflowCooldown();
    if (state.iteration - state.lastOverflowCompactionIteration < cooldown) return false;
    const check = contextManager.checkOverflowAllowed();
    if (check.implausible) {
      this.deps.logger.diagnostic(
        "warn",
        `Implausible context estimate jump (raw ${check.raw}, calibrated ${check.calibrated}) — overflow compaction skipped`,
      );
      return false;
    }
    if (!check.allowed) return false;
    state.lastOverflowCompactionIteration = state.iteration;
    return this.compactV2(
      state,
      `overflow (${check.calibrated} > ${contextManager.getBudget().history})`,
    );
  }

  /** Fallback-триггеры v2: pending/качество/интервал. */
  private tryFallbackV2(state: LoopState): void {
    const trigger = this.fallbackTrigger(state);
    if (!trigger) return;
    if (trigger.qualityDue) state.lastForcedCompactionIteration = state.iteration;
    this.compactV2(state, trigger.reason);
  }

  /** Решает, есть ли fallback-причина компакции, и какова она. */
  private fallbackTrigger(
    state: LoopState,
  ): { reason: string; qualityDue: boolean } | null {
    const { contextManager } = this.deps;
    const pending = state.pendingCompaction;
    state.pendingCompaction = false;
    const quality = contextManager.getQuality();
    if (this.qualityFallbackDue(state, quality)) {
      return {
        reason: `quality-triggered (${quality}% < ${QUALITY_TRIGGER_THRESHOLD}%)`,
        qualityDue: true,
      };
    }
    if (contextManager.needsIntervalCompaction?.() ?? false) {
      return { reason: "interval", qualityDue: false };
    }
    if (this.pendingFallbackDue(state, pending)) {
      return { reason: "after-tool", qualityDue: false };
    }
    return null;
  }

  /** Quality-триггер с cooldown. */
  private qualityFallbackDue(state: LoopState, quality: number): boolean {
    const { contextManager } = this.deps;
    return (
      quality < QUALITY_TRIGGER_THRESHOLD &&
      contextManager.getCompactionCount() > 0 &&
      state.iteration - state.lastForcedCompactionIteration >= FORCED_COMPACTION_COOLDOWN
    );
  }

  /**
   * pending после тула обычно означает превышение порога — это территория
   * overflow, не дублируем его внутри cooldown.
   */
  private pendingFallbackDue(state: LoopState, pending: boolean): boolean {
    if (!pending) return false;
    const recentOverflow =
      state.iteration - state.lastOverflowCompactionIteration <
      this.deps.contextManager.getOverflowCooldown();
    return !recentOverflow;
  }

  /**
   * v2-компакция с гарантией прогресса. No-op (reducedBy ≤ 2% бюджета) не
   * логируется и не инкрементит счётчик.
   */
  private compactV2(state: LoopState, reason: string): boolean {
    const { contextManager } = this.deps;
    const minReduction = Math.floor(contextManager.getBudget().history * 0.02);
    const result = contextManager.compactAdaptive({
      toolResultKeep: contextManager.getToolResultKeep(),
      minReduction,
    });
    if (!result || result.reducedBy <= minReduction) return false;
    this.deps.logger.debug(`Context compacted (${result.strategy})`);
    this.deps.slog.logCompaction({ reason, iteration: state.iteration, ...result });
    this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
    return true;
  }

  // ── legacy ────────────────────────────────────────────────────────────────

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
