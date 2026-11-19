// Решение финального аудита о тестовом прогоне: когда гонять, когда скипать, что кэшировать.
//
// Контракт — docs/specs/2026-10-30-audit-test-run-budget-design.md. Полный прогон
// на чат-ходе без файловых мутаций — 90 с впустую; повторный прогон на неизменном
// дереве — тоже. Таймаут обязан быть `inconclusive`, а не «прошло».
import { findTestFile, resolveTestCommand, runTests, type TestRunCheck } from "./audit-runners";
import { getCachedTestRun, setCachedTestRun, testTreeFingerprint } from "./audit-test-cache";

/** Входные данные вызывающего: знает ли он про мутации хода. */
export interface ResolveTestRunOptions {
  /**
   * Были ли за текущий ход успешные файловые мутации. `false` — сломать тесты
   * нечем, прогон не нужен; `undefined` — вызывающий не знает, проверяем.
   */
  mutated?: boolean;
}

/** Результат «прогон не нужен»: виден в сводке/логе как `skipped: …`. */
function skippedRun(baseDir: string): TestRunCheck {
  return {
    checked: false,
    passed: false,
    status: "skipped",
    failed: 0,
    passedCount: 0,
    detail: "skipped: no file mutations this turn",
    command: resolveTestCommand(baseDir),
    durationMs: 0,
  };
}

/**
 * Человекочитаемая пометка прогона для `session.jsonl` (INV-15), или null если
 * прогон обычный: скип, inconclusive и кэш обязаны быть отличимы от «проверено».
 */
export function testRunNote(run: TestRunCheck | null): string | null {
  if (!run) return null;
  if (run.status === "skipped") return run.detail;
  if (run.status === "inconclusive") return `${run.detail} (${run.durationMs}ms)`;
  if (run.cached) return `cached: ${run.detail}`;
  return null;
}

/**
 * Резолвит тестовый прогон для финального аудита.
 *
 * @param baseDir корень проекта; @param opts мутации хода.
 * @returns прогон (реальный, кэш или скип) либо null — тестов в проекте нет/сбой инфры.
 */
export async function resolveTestRun(
  baseDir: string,
  opts: ResolveTestRunOptions = {},
): Promise<TestRunCheck | null> {
  if (!findTestFile(baseDir)) return null;
  if (opts.mutated === false) return skippedRun(baseDir);

  const fingerprint = testTreeFingerprint(baseDir);
  if (fingerprint) {
    const cached = getCachedTestRun(baseDir, fingerprint);
    if (cached) return cached;
  }

  let run: TestRunCheck;
  try {
    run = await runTests(baseDir);
  } catch {
    return null; // сбой инфры — на нём не блокируемся
  }
  if (fingerprint) setCachedTestRun(baseDir, fingerprint, run);
  return run;
}
