import { describe, it, expect } from "vitest";
import { HallucinationGate } from "../../src/core/agent/hallucination-gate";
import { createLoopState } from "../../src/core/agent/loop-state";

function gateDeps(history: Array<{ role: string; name?: string; content?: unknown; success?: boolean }>) {
  const added: Array<{ role: string; content: string }> = [];
  return {
    deps: {
      state: createLoopState(),
      textContent: "✅ MMA 2.8.0 опубликована на npm",
      input: "опубликуй на npm",
      exitOnComplete: false,
      hasFinalAudit: false,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      contextManager: {
        addMessage: (m: { role: string; content: string }) => {
          added.push(m);
        },
        getActiveHistory: () => history,
      },
      onMeta: undefined,
      onChunk: undefined,
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
});
