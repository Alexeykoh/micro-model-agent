import { describe, it, expect } from "vitest";
import { HallucinationGate } from "../../src/core/agent/hallucination-gate";
import { createLoopState } from "../../src/core/agent/loop-state";

function gateDeps(
  history: Array<{ role: string; name?: string; content?: unknown; success?: boolean }>,
  textContent = "✅ MMA 2.8.0 опубликована на npm",
  artifacts?: Array<{ path: string; exists: boolean; parseError?: string }>,
) {
  const added: Array<{ role: string; content: string }> = [];
  return {
    deps: {
      state: createLoopState(),
      textContent,
      input: "опубликуй на npm",
      exitOnComplete: false,
      hasFinalAudit: false,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        diagnostic: () => {},
      },
      contextManager: {
        addMessage: (m: { role: string; content: string }) => {
          added.push(m);
        },
        getActiveHistory: () => history,
      },
      onMeta: undefined,
      onChunk: undefined,
      verbose: false,
      artifacts,
    } as any,
    added,
  };
}

const detectorStub = {
  validate: () => ({ status: "pass" as const }),
  getConfidenceCheck: () => ({ setPreviousResponse: () => {} }),
} as any;

describe("HallucinationGate success-claim check", () => {
  it("retries once on a contradicted claim, then accepts (fail-open)", async () => {
    const { deps, added } = gateDeps([
      { role: "tool", name: "bash", content: '{"latest": "2.5.0"}', success: true },
      { role: "tool", name: "bash", content: "npm error 404 No match found", success: false },
    ]);
    const gate = new HallucinationGate(detectorStub);
    const first = await gate.evaluate(deps);
    expect(first.action).toBe("retry");
    expect(added.some((m) => m.content.includes("process") || m.content.includes("claim") || m.content.includes("успех"))).toBe(true);

    const second = await gate.evaluate(deps);
    expect(second.action).toBe("accept");
  });

  it("accepts immediately when evidence is clean", async () => {
    const { deps } = gateDeps([
      { role: "tool", name: "bash", content: "2644 pass, 0 fail", success: true },
    ]);
    const gate = new HallucinationGate(detectorStub);
    const verdict = await gate.evaluate({ ...deps, textContent: "Done, all green" });
    expect(verdict.action).toBe("accept");
  });

  it("retries a 'valid' claim about an unparseable artifact, then accepts (fail-open)", async () => {
    const { deps, added } = gateDeps(
      [{ role: "tool", name: "write_file", content: "written", success: true }],
      "Готово! Файл schema.drawio создан, валидный XML.",
      [{ path: "schema.drawio", exists: true, parseError: "Mismatched tag (line 1)" }],
    );
    const gate = new HallucinationGate(detectorStub);
    const first = await gate.evaluate(deps);
    expect(first.action).toBe("retry");
    expect(added.some((m) => m.content.includes("schema.drawio"))).toBe(true);

    const second = await gate.evaluate(deps);
    expect(second.action).toBe("accept");
  });

  it("retries framed-as-executed output with no execution tool behind it", async () => {
    const { deps } = gateDeps(
      [{ role: "tool", name: "write_file", content: "written", success: true }],
      "Покажу вывод программы текстом:\n```\n1 2 Fizz\n```",
    );
    const gate = new HallucinationGate(detectorStub);
    const verdict = await gate.evaluate(deps);
    expect(verdict.action).toBe("retry");
  });

  it("gives each claim class its own retry budget", async () => {
    // One consumed success-claim retry must not shield an artifact lie in a
    // later answer (observed live: fizzbuzz_output.txt claimed while missing).
    const { deps } = gateDeps(
      [{ role: "tool", name: "bash", content: "npm error 404", success: false }],
      "✅ Опубликовано. Файл out.txt создан.",
      [{ path: "out.txt", exists: false }],
    );
    const gate = new HallucinationGate(detectorStub);
    const first = await gate.evaluate(deps);
    expect(first.action).toBe("retry");
    // Success budget exhausted, artifact budget fresh → still retries.
    const second = await gate.evaluate(deps);
    expect(second.action).toBe("retry");
    // Both budgets exhausted → fail-open accept.
    const third = await gate.evaluate(deps);
    expect(third.action).toBe("accept");
  });
});
