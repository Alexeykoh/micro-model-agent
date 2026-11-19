/**
 * «Нет новых улик» после не-ok вердикта (живая сессия
 * `ses_mvzp8cuk_ntwlmbthlcifwp`): модель дважды ответила описанием плана без
 * единого тула. Второй проход критика стоил ~19 с и вернул тот же `critical`,
 * а ход затем завершился как успешный без следа в журнале.
 *
 * Новый контракт: если после не-ok вердикта улики (тул-события) не изменились,
 * критик не вызывается повторно; вместо этого один раз выдаётся директива
 * «действуй, а не описывай», затем ответ принимается честно с записью
 * `critic_verdict { accepted, exhausted }`.
 */
import { describe, it, expect, vi } from "vitest";
import { CriticGate } from "../../src/core/agent/critic-gate";
import { createLoopState } from "../../src/core/agent/loop-state";
import type { CriticGateDeps } from "../../src/core/agent/critic-contract";
import type { CriticVerdict, EvidencePack } from "../../src/modules/critic/types";

const CRITICAL: CriticVerdict = {
  status: "critical",
  summary: "no work was done, the task is not completed",
  issues: [],
};

interface Harness {
  gate: CriticGate;
  verify: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof createLoopState>;
  messages: Array<{ role: string; content: string }>;
  verdicts: Array<Record<string, unknown>>;
  makeDeps: (over: Partial<CriticGateDeps>) => CriticGateDeps;
}

function makeHarness(): Harness {
  const state = createLoopState();
  const messages: Array<{ role: string; content: string }> = [];
  const verdicts: Array<Record<string, unknown>> = [];
  const verify = vi.fn(async () => CRITICAL);
  const slog = {
    logCritic: vi.fn((event: string, data: Record<string, unknown>) => {
      if (event === "critic_verdict") verdicts.push(data);
    }),
    logRetract: vi.fn(),
    logDiagnosticEvent: vi.fn(),
  };
  const gate = new CriticGate({
    enabled: true,
    maxCalls: 5,
    maxRepairCycles: 1,
    verify: verify as unknown as (pack: EvidencePack) => Promise<CriticVerdict | null>,
    buildPack: () => ({}) as EvidencePack,
  });
  const makeDeps = (over: Partial<CriticGateDeps>): CriticGateDeps =>
    ({
      state,
      iteration: 4,
      logger: { diagnostic: vi.fn() },
      contextManager: {
        addMessage: vi.fn((m: { role: string; content: string }) => messages.push(m)),
      },
      slog,
      task: "fix the bugs and verify with playwright",
      toolEvents: [{ tool: "list_dir", ok: true, output: "files" }],
      beforeFinish: true,
      answerText: "checking the data structure",
      onMeta: vi.fn(),
      ...over,
    }) as unknown as CriticGateDeps;
  return { gate, verify, state, messages, verdicts, makeDeps };
}

describe("critic: новые улики после не-ok вердикта", () => {
  it("второй ответ без тулов не перепроверяется: директива «действуй», потом честное принятие", async () => {
    const h = makeHarness();

    // 1) Critical на свежих уликах → ремонт (retry), критик вызван один раз.
    expect(await h.gate.evaluate(h.makeDeps({ answerText: "checking the data structure" }))).toBe(
      "retry",
    );
    expect(h.verify).toHaveBeenCalledTimes(1);

    // 2) Тот же набор тулов, другой текст → критик НЕ вызывается, директива.
    expect(await h.gate.evaluate(h.makeDeps({ answerText: "now checking App.tsx" }))).toBe("retry");
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.messages.some((m) => m.content.includes("no work was done"))).toBe(true);

    // 3) Ещё раз без тулов → бюджет «действуй» исчерпан, ответ принимается.
    expect(await h.gate.evaluate(h.makeDeps({ answerText: "checking App.tsx once more" }))).toBe(
      "pass",
    );
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.verdicts.some((v) => v.accepted === true && v.exhausted === true)).toBe(true);
  });

  it("новая работа тулом — это новая улика: критик проверяет заново", async () => {
    const h = makeHarness();
    expect(await h.gate.evaluate(h.makeDeps({ answerText: "checking" }))).toBe("retry");
    const withWork = h.makeDeps({
      answerText: "fixed",
      toolEvents: [
        { tool: "list_dir", ok: true, output: "files" },
        { tool: "write_file", ok: true, output: "done" },
      ],
    });
    expect(await h.gate.evaluate(withWork)).toBe("retry");
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("чат-доставка (тулов в ходу нет) не попадает под правило", async () => {
    const h = makeHarness();
    const chat = (answerText: string) => h.makeDeps({ answerText, toolEvents: [] });
    await h.gate.evaluate(chat("first draft"));
    await h.gate.evaluate(chat("second draft"));
    expect(h.verify).toHaveBeenCalledTimes(2);
  });
});
