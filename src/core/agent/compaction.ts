/** Компакция контекста: единая точка всех триггеров цикла. */
import type { ContextManager } from "../../core/context/manager";
import type { HallucinationDetector } from "../../core/hallucination/detector";
import type { Logger } from "../../logger/app-logger";
import type { SessionLogger } from "../session-logger";
import type { LoopState } from "./loop-state";
import { FORCED_COMPACTION_COOLDOWN, QUALITY_TRIGGER_THRESHOLD } from "./constants";

/**
 * Порог значимости компакции. Больше из двух: 2% бюджета истории и 3% текущего
 * (калиброванного) контекста. Привязка к контексту не даёт «сжатию впустую»
 * (напр. −1.2% на 24K) считаться успехом и короткозамкнуть эскалацию стадий —
 * такой результат уходит на aggressive/hard-drop.
 */
export function computeMinReduction(budgetHistory: number, contextTokens: number): number {
  return Math.max(Math.floor(budgetHistory * 0.02), Math.floor(contextTokens * 0.03));
}

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
    // 0) Общий кулдаун поперёк семейств: ни одной компакции ближе кулдауна,
    //    независимо от того, какое семейство её просит. Без него overflow и
    //    quality с независимыми клоками чередовались через итерацию (интервал 1
    //    при кулдауне 3) — тот же разбег, что у after-tool до C2 (W4).
    if (state.iteration - state.lastCompactionIteration < FORCED_COMPACTION_COOLDOWN) return;
    // 1) Overflow — канонический порог по истории (калиброванная оценка),
    //    cooldown и safety-clamp от неправдоподобного скачка.
    if (this.tryOverflowV2(state) !== "") return;
    // 2) Один из оставшихся триггеров: pending (после тула), качество, интервал.
    this.tryFallbackV2(state);
  }

  /**
   * Overflow-триггер v2 с cooldown и safety-clamp.
   *
   * Возвращает причину: `""` — триггер не сработал, `"compacted"` — контекст
   * ужат, `"skipped_no_reduction"` — ужать нечего (несжимаемый хвост).
   *
   * Флаг `lastOverflowCompactionIteration` ставится ТОЛЬКО при реальном
   * сокращении: иначе overflow, который нельзя ужать, повторялся каждые
   * `cooldown` итераций без прогресса (§3.7 аудита).
   */
  private tryOverflowV2(state: LoopState): string {
    const { contextManager } = this.deps;
    const cooldown = contextManager.getOverflowCooldown();
    if (state.iteration - state.lastOverflowCompactionIteration < cooldown) return "";
    const check = contextManager.checkOverflowAllowed();
    if (check.implausible) {
      this.deps.logger.diagnostic(
        "warn",
        `Implausible context estimate jump (raw ${check.raw}, calibrated ${check.calibrated}) — overflow compaction skipped`,
      );
      return "";
    }
    if (!check.allowed) return "";
    state.lastCompactionIteration = state.iteration;
    const compacted = this.compactV2(
      state,
      `overflow (${check.calibrated} > ${contextManager.getBudget().history})`,
    );
    if (!compacted.compacted) {
      this.deps.logger.diagnostic?.(
        "warn",
        "Overflow compaction skipped: no reduction possible (unshrinkable context)",
      );
      this.deps.slog.logCompaction({
        reason: "skipped_no_reduction",
        iteration: state.iteration,
      });
      return "skipped_no_reduction";
    }
    state.lastOverflowCompactionIteration = state.iteration;
    return "compacted";
  }

  /** Fallback-триггеры v2: pending/качество/интервал. */
  private tryFallbackV2(state: LoopState): void {
    const trigger = this.fallbackTrigger(state);
    if (!trigger) return;
    state.lastCompactionIteration = state.iteration;
    if (trigger.qualityDue) state.lastForcedCompactionIteration = state.iteration;
    if (trigger.pendingDue) state.lastPendingCompactionIteration = state.iteration;
    this.compactV2(state, trigger.reason);
  }

  /** Решает, есть ли fallback-причина компакции, и какова она. */
  private fallbackTrigger(
    state: LoopState,
  ): { reason: string; qualityDue: boolean; pendingDue?: boolean } | null {
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
      return { reason: "after-tool", qualityDue: false, pendingDue: true };
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
    // Свой cooldown: без него, пока токены > порога после «оставить 12», после
    // каждого tool-результата компакция срабатывала бы почти каждую итерацию.
    return (
      !recentOverflow &&
      state.iteration - state.lastPendingCompactionIteration >= FORCED_COMPACTION_COOLDOWN
    );
  }

  /**
   * v2-компакция с гарантией прогресса. No-op (reducedBy ≤ порога значимости,
   * см. `computeMinReduction`) не логируется и не инкрементит счётчик.
   */
  private compactV2(state: LoopState, reason: string): { compacted: boolean; reducedBy: number } {
    const { contextManager } = this.deps;
    const minReduction = computeMinReduction(
      contextManager.getBudget().history,
      contextManager.getContextTokens(),
    );
    const result = contextManager.compactAdaptive({
      toolResultKeep: contextManager.getToolResultKeep(),
      minReduction,
    });
    if (!result || result.reducedBy <= minReduction) {
      return { compacted: false, reducedBy: result?.reducedBy ?? 0 };
    }
    this.deps.logger.debug(`Context compacted (${result.strategy})`);
    this.deps.slog.logCompaction({ reason, iteration: state.iteration, ...result });
    this.deps.hallucinationDetector.addKnownFiles(contextManager.getKnownFiles());
    return { compacted: true, reducedBy: result.reducedBy };
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
