import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseSession, SIGNATURE_KINDS, thresholds } from "../../src/modules/session/diagnose";

/**
 * Gate for `mma session diagnose` (W5): the anonymised fixture of a real bad
 * session must yield the signatures that actually caused fixes.
 *
 * The assertion is on STRUCTURE (`kind`/`count`), never on the human text —
 * text assertions break on every rewording.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "session-diagnose", "session.jsonl");

function fixtureEntries(): Record<string, unknown>[] {
  return readFileSync(FIXTURE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("session diagnose (W5)", () => {
  it("finds at least five distinct signatures on the real bad session", () => {
    const report = diagnoseSession("ses_fixture", fixtureEntries());
    expect(report.entries).toBeGreaterThan(500);
    const kinds = new Set(report.signatures.map((s) => s.kind));
    expect(
      kinds.size,
      `Only ${kinds.size} signature kinds on a session that produced four fixes: ` +
        `${[...kinds].join(", ")}`,
    ).toBeGreaterThanOrEqual(5);
  });

  it("flags the compaction stall this session actually had", () => {
    const report = diagnoseSession("ses_fixture", fixtureEntries());
    const stall = report.signatures.find((s) => s.kind === "compaction_stall");
    expect(stall, "20 consecutive compactions must read as a stall").toBeDefined();
    expect(stall?.count).toBeGreaterThanOrEqual(10);
  });

  it("flags repeated security blocks of one pattern", () => {
    const report = diagnoseSession("ses_fixture", fixtureEntries());
    const blocked = report.signatures.filter((s) => s.kind === "security_block_repeat");
    expect(blocked.length).toBeGreaterThan(0);
    for (const s of blocked) {
      expect(s.count).toBeGreaterThanOrEqual(thresholds.securityBlockRepeat);
    }
  });

  it("reports every signature kind it claims to support", () => {
    const report = diagnoseSession("ses_fixture", fixtureEntries());
    for (const s of report.signatures) {
      expect(SIGNATURE_KINDS).toContain(s.kind);
      expect(s.first).toBeTruthy();
      expect(s.detail).toBeTruthy();
    }
  });

  it("flags a turn that stood in the post-answer gates (gate_stall)", () => {
    // A15: ответ уже в ленте, а ход висит — сигнатура показывает, где именно.
    const entry = (duration: number, gates: Record<string, number>) => ({
      ts: "2026-10-30T10:00:00.000Z",
      type: "gate_timing",
      content: `gates ${duration}ms`,
      duration,
      gates,
    });
    expect(
      diagnoseSession("ses_fast", [entry(4_000, { hallucination: 100, critic: 3_900 })]).signatures,
    ).toEqual([]);
    const report = diagnoseSession("ses_slow", [
      entry(121_000, { hallucination: 200, critic: 20_000, audit: 100_800 }),
    ]);
    const sig = report.signatures.find((s) => s.kind === "gate_stall");
    expect(sig, "121 с в пост-проверке обязан быть стоп-сигналом").toBeDefined();
    expect(sig?.count).toBe(1);
    // Разбивка по гейтам — в detail, иначе непонятно, кто виноват.
    expect(sig?.detail).toContain("audit");
  });

  it("returns no signatures for a clean session instead of throwing", () => {
    const report = diagnoseSession("ses_clean", [
      { ts: "2026-10-15T10:00:00.000Z", type: "user", content: "hi" },
      { ts: "2026-10-15T10:00:01.000Z", type: "assistant", content: "hello" },
    ]);
    expect(report.signatures).toEqual([]);
    expect(report.summary.criticErrors).toBe(0);
  });

  it("does not count a single block as a repeat", () => {
    const report = diagnoseSession("ses_one", [
      {
        ts: "2026-10-15T10:00:00.000Z",
        type: "tool_result",
        tool: "bash",
        success: false,
        content: '[SECURITY BLOCKED] Command is not allowed: Operator "|" is not allowed',
      },
    ]);
    expect(report.signatures.map((s) => s.kind)).not.toContain("security_block_repeat");
  });

  it("reports a repeated block of one pattern once, with its count", () => {
    const blocked = (op: string) => ({
      ts: "2026-10-15T10:00:00.000Z",
      type: "tool_result",
      tool: "bash",
      success: false,
      content: `[SECURITY BLOCKED] Command is not allowed: Operator "${op}" is not allowed`,
    });
    const report = diagnoseSession("ses_repeat", [blocked("|"), blocked("|"), blocked(">")]);
    const sig = report.signatures.find((s) => s.kind === "security_block_repeat");
    expect(sig).toBeDefined();
    expect(sig?.count).toBe(2);
  });

  it("flags a tool that fails repeatedly (tool_failure_repeat)", () => {
    const fail = (i: number) => ({
      ts: `2026-10-15T10:00:0${i}.000Z`,
      type: "tool_result",
      tool: "bash",
      success: false,
      content: "ENOENT: no such file",
    });
    const report = diagnoseSession("ses_toolfail", [fail(1), fail(2), fail(3)]);
    const sig = report.signatures.find((s) => s.kind === "tool_failure_repeat");
    expect(sig, "три падения одного тула — это паттерн").toBeDefined();
    expect(sig?.count).toBe(thresholds.toolFailureRepeat);
  });

  it("flags a prompt block dropped from the budget (prompt_block_dropped)", () => {
    const report = diagnoseSession("ses_dropped", [
      {
        ts: "2026-10-15T10:00:00.000Z",
        type: "context",
        blocks: [{ label: "docs", included: false, tokens: 500 }],
      },
    ]);
    const sig = report.signatures.find((s) => s.kind === "prompt_block_dropped");
    expect(sig, "выкинутый из бюджета блок обязан быть виден").toBeDefined();
    expect(sig?.count).toBe(1);
  });
});
