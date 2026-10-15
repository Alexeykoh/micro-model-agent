import { describe, it, expect } from "vitest";
import { LLMJudge } from "../../src/core/hallucination/llm-judge";
import { ConsistencyCheck } from "../../src/core/hallucination/consistency";
import type { Chunk, LLMProvider } from "../../src/llm/provider";
import type { Diagnostic } from "../../src/output/types";

/**
 * Gate for the hallucination judge's fail-open (INV-15, W10.1).
 *
 * When the judge cannot answer (provider down, timeout, unparseable output) the
 * verdict degrades to `pass` — deliberately, so a broken judge cannot block a
 * turn. But a silent `pass` is indistinguishable from "the model was
 * consistent", which is how the summarizer's missing reasoning strategy stayed
 * invisible for so long. A degrade must leave a trace.
 */

function consistencyWithOneDecision(): ConsistencyCheck {
  const check = new ConsistencyCheck();
  check.trackDecision("Use Bun, not Node", "build");
  return check;
}

/** Провайдер, который падает на первом же чанке. Интерфейс полный — без каста. */
function failingProvider(cause: string): LLMProvider {
  return {
    model: "judge-test",
    contextWindow: 4096,
    // eslint-disable-next-line require-yield
    async *chat(): AsyncIterable<Chunk> {
      throw new Error(cause);
    },
    countTokens: () => 1,
    listModels: async () => [],
  };
}

/** Провайдер, отвечающий заданным текстом. */
function answeringProvider(text: string): LLMProvider {
  return {
    model: "judge-test",
    contextWindow: 4096,
    // eslint-disable-next-line require-yield
    async *chat(): AsyncIterable<Chunk> {
      yield { type: "text", content: text };
    },
    countTokens: () => 1,
    listModels: async () => [],
  };
}

describe("LLMJudge fail-open observability (W10.1)", () => {
  it("returns pass when the provider fails", async () => {
    const judge = new LLMJudge(failingProvider("provider exploded"));
    const result = await judge.validate("some response", consistencyWithOneDecision());
    expect(result.status).toBe("pass");
  });

  it("emits a diagnostic with the cause when the provider fails", async () => {
    const diags: Diagnostic[] = [];
    const judge = new LLMJudge(failingProvider("provider exploded"), "s1", (d) => diags.push(d));
    await judge.validate("some response", consistencyWithOneDecision());
    expect(diags, "a degraded judge must not pass silently").toHaveLength(1);
    expect(diags[0]).toMatchObject({
      source: "core",
      operation: "hallucination.judge",
      kind: "degraded",
    });
    expect(diags[0].cause).toContain("provider exploded");
  });

  it("does not call the provider when there is nothing to check", async () => {
    const diags: Diagnostic[] = [];
    let calls = 0;
    const base = answeringProvider("unused");
    const provider: LLMProvider = {
      ...base,
      // eslint-disable-next-line require-yield
      async *chat(): AsyncIterable<Chunk> {
        calls++;
        throw new Error("should not be called");
      },
    };
    const judge = new LLMJudge(provider, "s1", (d) => diags.push(d));
    const result = await judge.validate("response", new ConsistencyCheck());
    expect(result.status).toBe("pass");
    expect(calls).toBe(0);
    expect(diags).toEqual([]);
  });

  it("emits no diagnostic when the judge answers normally", async () => {
    const diags: Diagnostic[] = [];
    const judge = new LLMJudge(answeringProvider('{"contradicts": false}'), "s1", (d) =>
      diags.push(d),
    );
    const result = await judge.validate("response", consistencyWithOneDecision());
    expect(result.status).toBe("pass");
    expect(diags).toEqual([]);
  });
});