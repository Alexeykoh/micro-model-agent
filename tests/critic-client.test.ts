import { describe, it, expect } from "vitest";
import { parseVerdict, CriticClient } from "../src/modules/critic/client";
import type { LLMProvider } from "../src/llm/provider";

function providerReturning(text: string): LLMProvider {
  return {
    model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
    async *chat() {
      yield { type: "text" as const, content: text };
      yield { type: "done" as const };
    },
  };
}

describe("parseVerdict", () => {
  it("parses plain JSON", () => {
    expect(parseVerdict('{"status":"ok","summary":"fine","issues":[]}')?.status).toBe("ok");
  });
  it("repairs slightly broken JSON", () => {
    expect(parseVerdict('{"status":"concern","summary":"x","issues":[]')?.status).toBe("concern");
  });
  it("returns null on garbage", () => {
    expect(parseVerdict("not json")).toBeNull();
  });
});

describe("CriticClient", () => {
  it("fails open to null on provider error", async () => {
    const provider: LLMProvider = {
      model: "m", contextWindow: 1000, countTokens: () => 0, listModels: async () => [],
      // eslint-disable-next-line require-yield
      async *chat() { throw new Error("boom"); },
    };
    const client = new CriticClient({ provider });
    expect(await client.verify({ task: "t", changedFiles: [], commands: [], toolDigest: "" })).toBeNull();
  });
});
