import { describe, it, expect, vi } from "vitest";
import { parseVerdict, parseVerdictDetailed, extractChecks } from "../src/modules/critic/verdict";
import { CriticGate } from "../src/core/agent/critic-gate";
import { createLoopState } from "../src/core/agent/loop-state";

/**
 * Разбор вердикта критика (W2, INV-C2/INV-C3).
 *
 * Реальная поломка: действие гейта определялось только списком `issues`.
 * Вердикт `critical` без распарсенных issues исчезал молча — «critic_check»
 * без следа о вердикте читается как «проверил и сказал ок». Плюс статус и
 * severity разбирались регистрозависимо: `"Critical"` → null → fail-open.
 */
describe("critic verdict parsing (W2)", () => {
  it("accepts a capitalized status (case must not decide the verdict)", () => {
    expect(parseVerdict('{"status":"OK","summary":"fine","issues":[]}')?.status).toBe("ok");
    expect(parseVerdict('{"status":"Critical","summary":"broken","issues":[]}')?.status).toBe(
      "critical",
    );
    expect(parseVerdict('{"status":" concern ","summary":"gap","issues":[]}')?.status).toBe(
      "concern",
    );
  });

  it("normalizes issue severity to the known set", () => {
    const v = parseVerdict(
      '{"status":"critical","summary":"s","issues":[{"severity":"Critical","claim":"c","problem":"p"}]}',
    );
    expect(v?.issues[0].severity).toBe("critical");
    const unknown = parseVerdict(
      '{"status":"concern","summary":"s","issues":[{"severity":"huge","claim":"c","problem":"p"}]}',
    );
    expect(unknown?.issues[0].severity).toBe("concern");
  });

  it("does not call a fenced or prose-wrapped verdict 'repaired'", () => {
    // Код-fences и хвостовая проза — не порча вердикта: чинить нечего.
    const fenced = parseVerdictDetailed('```json\n{"status":"ok","summary":"fine","issues":[]}\n```');
    expect(fenced.verdict?.status).toBe("ok");
    expect(fenced.repaired).toBe(false);
    const prose = parseVerdictDetailed('{"status":"ok","summary":"fine","issues":[]} — done');
    expect(prose.verdict?.status).toBe("ok");
    expect(prose.repaired).toBe(false);
  });

  it("still flags a truncated verdict as repaired (it may be a false ok)", () => {
    const truncated = parseVerdictDetailed('{"status":"ok","summary":"fine","iss');
    expect(truncated.repaired).toBe(true);
  });

  it("reads checks without a status (a valid request for read-only checks)", () => {
    const checks = extractChecks('{"checks":[{"tool":"read_file","args":{"path":"a.ts"}}]}');
    expect(checks).toEqual([{ tool: "read_file", args: { path: "a.ts" } }]);
  });
});

/** Гейт с моками: минимальный контекст для проверки решения гейта. */
function gateDeps(overrides: Record<string, unknown> = {}) {
  const state = createLoopState();
  state.mutationsSinceCritic = 1;
  const events: string[] = [];
  const messages: unknown[] = [];
  return {
    state,
    events,
    messages,
    deps: {
      state,
      iteration: 4,
      logger: { warn: vi.fn(), info: vi.fn(), diagnostic: vi.fn() } as never,
      contextManager: { addMessage: (m: unknown) => messages.push(m) } as never,
      slog: {
        logCritic: (name: string) => events.push(name),
        logDiagnosticEvent: (name: string) => events.push(name),
      } as never,
      task: "do it",
      beforeFinish: true,
      toolEvents: [{ tool: "bash", args: { command: "ls" }, ok: true }],
      ...overrides,
    },
  };
}

describe("critic gate keeps a non-ok verdict (W2, INV-C2)", () => {
  it("escalates a critical verdict that carries no parseable issues", () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({ status: "critical", summary: "the result is not delivered", issues: [] }),
      buildPack: (x: never) => x,
    });
    return gate.evaluate(d.deps).then((action) => {
      expect(action).toBe("retry");
      // Вердикт виден в логе: раньше он исчезал, оставляя один critic_check.
      expect(d.events).toContain("critic_verdict");
      expect(d.events).toContain("critic_escalation");
      expect(d.messages.length).toBe(1);
    });
  });

  it("logs a concern verdict without issues instead of swallowing it", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({ status: "concern", summary: "numbers are unverified", issues: [] }),
      buildPack: (x: never) => x,
    });
    const action = await gate.evaluate(d.deps);
    expect(action).toBe("pass");
    expect(d.events).toContain("critic_verdict");
  });

  it("dedupes by the same key it uses to detect repeats", async () => {
    const d = gateDeps();
    const gate = new CriticGate({
      enabled: true,
      maxCalls: 4,
      maxRepairCycles: 1,
      verify: async () => ({
        status: "critical" as const,
        summary: "broken",
        issues: [{ severity: "critical" as const, claim: "Missing file.", problem: "p" }],
      }),
      buildPack: (x: never) => x,
    });
    expect(await gate.evaluate(d.deps)).toBe("retry");
    const messagesAfterFirst = d.messages.length;
    // Тот же вердикт второй раз: повтор — ремонт не тратим, но вердикт виден.
    expect(await gate.evaluate(d.deps)).toBe("pass");
    expect(d.messages.length).toBe(messagesAfterFirst);
    expect(d.events.filter((e) => e === "critic_verdict").length).toBe(2);
  });
});
