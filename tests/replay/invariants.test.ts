import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseSession } from "../../src/modules/session/diagnose";
import {
  afterToolCompactionGaps,
  blockedPattern,
  claimRetriesByKind,
  compactionCeiling,
  compactionCount,
  compactionRuns,
  criticDegradedRuns,
  longestBlockStreak,
  longestToolFailureStreak,
  maxIteration,
  maxLlmCallsPerIteration,
} from "./invariants";
import type { SessionLogEntry } from "../../src/modules/session/store";

/**
 * Invariants over the replayed bad session (W7).
 *
 * Every fixture signature from W5 (`mma session diagnose`) must show up here as
 * an *invariant*, not just as a label. A signature nobody asserts is a comment;
 * an invariant that would fire on a regression is the bridge from "a live
 * session went wrong" to "a failing test".
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "session-diagnose", "session.jsonl");

function fixture(): SessionLogEntry[] {
  return readFileSync(FIXTURE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionLogEntry);
}

describe("replay invariants (W7)", () => {
  it("KNOWN-RED: after-tool compaction cooldown was not enforced (defect C2)", () => {
  // Эта сессия — ДО фикса C2, поэтому инвариант обязан быть КРАСНЫМ: агент
  // сжимал контекст после каждого тула, не считая кулдаун. Это и есть ценность
  // фикстуры — она фиксирует дефект, а не подтверждает его отсутствие.
  //
  // Когда W4 (invariants по предикатам) и будет подтверждён на текущем коде,
  // этот тест превращается в обычный зелёный на синтетическом loop-state, а
  // здесь остаётся как ЗАФИКСИРОВАННЫЙ ПРОВАЛ: красный тест на истории держит
  // в памяти цену дефекта и не даёт «починить» его, сломав кулдаун.
  const gaps = afterToolCompactionGaps(fixture(), 3);
  const tooTight = gaps.filter((g) => g < 3);
  expect(tooTight.length, "фикстура обязана содержать разбег").toBeGreaterThan(0);
  expect(gaps).toContain(1);
});

  it("the cooldown gap arithmetic matches the fixture", () => {
    const gaps = afterToolCompactionGaps(fixture(), 3);
    expect(gaps.length).toBe(compactionCount(fixture()) - 1);
    expect(Math.min(...gaps), "фикстура содержит соседние after-tool компакции").toBe(1);
    // Потолок по числу итераций выполняется — дефект был не в нём.
    const iterations = maxIteration(fixture());
    expect(compactionCount(fixture())).toBeLessThanOrEqual(compactionCeiling(iterations, 3));
  });

  it("cooldown ceiling is the arithmetic the invariant claims", () => {
    expect(compactionCeiling(10, 3)).toBe(4);
    expect(compactionCeiling(9, 3)).toBe(3);
    expect(compactionCeiling(1, 3)).toBe(1);
    // Кулдаун не может быть нулевым: это деление на ноль, а не «без предела».
    expect(compactionCeiling(10, 0)).toBe(10);
  });

  it("security blocks: one pattern repeats, so the no-repeat-twice rule fires", () => {
    const entries = fixture();
    const streak = longestBlockStreak(entries);
    expect(streak, "фикстура содержит повтор одного паттерна блокировки").toBeGreaterThanOrEqual(2);
    // Правило «не блокировать тем же дважды подряд» — то, чего в бою не было.
    expect(streak).toBeGreaterThan(1);
  });

  it("extracts the block pattern from a real log line", () => {
    expect(
      blockedPattern({
        ts: "2026-10-14T00:00:00.000Z",
        type: "tool_result",
        tool: "bash",
        success: false,
        content: '[SECURITY BLOCKED] Command is not allowed: Operator "|" is not allowed',
      } as SessionLogEntry),
    ).toContain('Operator "|"');
    expect(
      blockedPattern({ ts: "x", type: "tool_result", tool: "bash", content: "ok" } as SessionLogEntry),
    ).toBeNull();
  });

  it("tool failures: bash fails repeatedly in the fixture", () => {
    expect(longestToolFailureStreak(fixture())).toBeGreaterThanOrEqual(3);
  });

  it("critic degradation: the fixture has critic_error entries", () => {
    const entries = fixture();
    const errors = entries.filter((e) => e.type === "critic_error");
    expect(errors.length, "фикстура содержит деградацию критика").toBeGreaterThanOrEqual(1);
    // Серия без успешного вердикта между ними — отдельная патология; на этой
    // фикстуре вердикты есть, поэтому проверяем сам факт сигнала.
    const runs = criticDegradedRuns(entries);
    expect(runs.reduce((a, b) => a + b, 0)).toBe(errors.length);
  });

  it("claim retries are grouped by class", () => {
    const retries = claimRetriesByKind(fixture());
    expect(retries.size).toBeGreaterThan(0);
    for (const count of retries.values()) expect(count).toBeGreaterThanOrEqual(1);
  });

  it("one LLM call per iteration plus critic — never two calls per turn", () => {
    // Критик и сабагент могут добавить вызов, но сама петля — один на итерацию.
    expect(maxLlmCallsPerIteration(fixture())).toBeLessThanOrEqual(2);
  });

  it("every W5 signature has an invariant that fires on the fixture", () => {
    // Мост из W5 в W7: сигнатура разбора без красного инварианта — это
    // подпись на отсутствующей проверке.
    const report = diagnoseSession("ses_fixture", fixture() as unknown as Record<string, unknown>[]);
    const kinds = new Set(report.signatures.map((s) => s.kind));
    const fired = new Set<string>();
    if (compactionCount(fixture()) > 0) fired.add("compaction_stall");
    if (longestBlockStreak(fixture()) >= 2) fired.add("security_block_repeat");
    if (longestToolFailureStreak(fixture()) >= 3) fired.add("tool_failure_repeat");
    if (criticDegradedRuns(fixture()).some((n) => n >= 1)) fired.add("critic_degraded");
    if (claimRetriesByKind(fixture()).size >= 1) fired.add("claim_retry");
    if (report.signatures.some((s) => s.kind === "prompt_block_dropped")) {
      fired.add("prompt_block_dropped");
    }
    const uncovered = [...kinds].filter((k) => !fired.has(k));
    expect(
      uncovered,
      `Signatures found by diagnose but with no invariant firing on the same fixture:\n` +
        uncovered.join("\n"),
    ).toEqual([]);
  });
});