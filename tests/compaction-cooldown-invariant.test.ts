// W4: общий кулдаун компакции поперёк семейств триггеров. Синтетический
// loop-state, детерминированно (кулдаун — счётчик итераций, не часы).
import { describe, it, expect } from "vitest";
import { CompactionService } from "../src/core/agent/compaction";
import { createLoopState } from "../src/core/agent/loop-state";
import { FORCED_COMPACTION_COOLDOWN } from "../src/core/agent/constants";
import type { ContextManager } from "../src/core/context/manager";

/**
 * Гейт: нет двух компакций ближе кулдауна — независимо от того, какое семейство
 * триггеров её просит (W4).
 *
 * Дефект класса C: у каждого семейства (overflow/quality/pending) был свой клок,
 * и они чередовались. Overflow на итерации N и quality на N+1 давали интервал 1
 * при кулдауне 3 — тот же разбег, что у after-tool до фикса C2, только поперёк
 * семейств. Это и видно в фикстуре W7 (интервалы 72→73, 96→97). Единый
 * `lastCompactionIteration` закрывает класс: суммарная частота ≤ 1/кулдаун.
 *
 * Проверка на ПРЕДИКАТАХ, а не сценарием: контекст «всегда переполнен и низкого
 * качества», после каждого тула — pending. Адверсариальнее некуда, поэтому
 * потолок `ceil(N/коoldown)` здесь достижим и обязателен.
 */

const cooldown = FORCED_COMPACTION_COOLDOWN;

/** Фейковый ContextManager: все семейства триггеров «должны» каждую итерацию. */
function harness(opts: { overflowAllowed?: () => boolean } = {}) {
  const fires: Array<{ iteration: number; reason: string }> = [];
  const cm = {
    getPolicy: () => "v2" as const,
    getOverflowCooldown: () => cooldown,
    checkOverflowAllowed: () => ({
      allowed: opts.overflowAllowed?.() ?? true,
      raw: 1e6,
      calibrated: 1e6,
      implausible: false,
    }),
    getBudget: () => ({ history: 100 }),
    getContextTokens: () => 100000,
    getQuality: () => 0,
    getCompactionCount: () => 1,
    needsIntervalCompaction: () => false,
    getToolResultKeep: () => 2,
    compactAdaptive: () => ({ reducedBy: 100000, strategy: "summarize" }),
    needsCompaction: () => true,
    compact: () => ({ reducedBy: 100000, strategy: "summarize" }),
    getKnownFiles: () => [],
  } as unknown as ContextManager;
  const logger = {
    debug: () => {},
    diagnostic: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as never;
  const slog = {
    logCompaction: (info: { reason: string; iteration: number }) =>
      fires.push({ iteration: info.iteration, reason: info.reason }),
  } as never;
  const hallucinationDetector = { addKnownFiles: () => {} } as never;
  return {
    svc: new CompactionService({ contextManager: cm, logger, slog, hallucinationDetector }),
    fires,
  };
}

describe("gate: compaction cooldown across trigger families (W4)", () => {
  it("never fires two compactions closer than the cooldown, and never above ceil(N/cooldown)", () => {
    const { svc, fires } = harness();
    const state = createLoopState();
    const N = 30;
    for (let i = 1; i <= N; i++) {
      state.iteration = i;
      state.pendingCompaction = true; // после каждого тула
      svc.compactIfNeeded(state);
    }
    expect(fires.length, "гейт вакууозен: ни одной компакции").toBeGreaterThan(0);
    const iterations = fires.map((f) => f.iteration);
    const gaps = iterations.slice(1).map((v, idx) => v - iterations[idx]);
    expect(
      Math.min(...gaps),
      `соседние компакции ближе кулдауна: итерации ${iterations.join(",")}`,
    ).toBeGreaterThanOrEqual(cooldown);
    const ceiling = Math.ceil(N / cooldown);
    expect(
      fires.length,
      `срабатываний ${fires.length} > потолка ${ceiling} (N=${N}, кулдаун=${cooldown})`,
    ).toBeLessThanOrEqual(ceiling);
  });

  it("blocks a different family from firing right after another one", () => {
    // Overflow «должен» только на итерации 1; дальше не проходит safety-check, но
    // качество низкое и pending стоит. Без общего кулдауна quality сработала бы
    // на итерации 2 (интервал 1) — именно это и есть дефект.
    const allowed = { v: true };
    const { svc, fires } = harness({ overflowAllowed: () => allowed.v });
    const state = createLoopState();
    for (let i = 1; i <= 12; i++) {
      state.iteration = i;
      state.pendingCompaction = true;
      allowed.v = i === 1;
      svc.compactIfNeeded(state);
    }
    const reasons = fires.map((f) => f.reason);
    expect(reasons[0], "первым обязан сработать overflow").toContain("overflow");
    expect(
      reasons.length,
      `семейства не чередуются: ${reasons.join(" | ")}`,
    ).toBeGreaterThan(1);
    const iterations = fires.map((f) => f.iteration);
    const gaps = iterations.slice(1).map((v, idx) => v - iterations[idx]);
    expect(
      Math.min(...gaps),
      `разносемейные компакции ближе кулдауна: итерации ${iterations.join(",")}`,
    ).toBeGreaterThanOrEqual(cooldown);
  });

  it("keeps the per-family cooldowns as well (they are not replaced)", () => {
    // Общий кулдаун — дополнение, не замена: два overflow не ближе
    // overflow-кулдауна. Прямая проверка предиката на частном случае.
    const { svc, fires } = harness();
    const state = createLoopState();
    for (let i = 1; i <= 12; i++) {
      state.iteration = i;
      state.pendingCompaction = true;
      svc.compactIfNeeded(state);
    }
    const overflowDrops = fires.filter((f) => f.reason.includes("overflow"));
    expect(overflowDrops.length).toBeGreaterThan(1);
    for (let idx = 1; idx < overflowDrops.length; idx++) {
      expect(overflowDrops[idx].iteration - overflowDrops[idx - 1].iteration).toBeGreaterThanOrEqual(
        cooldown,
      );
    }
  });
});
