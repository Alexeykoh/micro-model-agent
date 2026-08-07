import { describe, it, expect } from "vitest";
import { HallucinationDetector } from "../src/modules/hallucination/detector";

describe("HallucinationDetector", () => {
  it("should pass on normal response", async () => {
    const detector = new HallucinationDetector();
    const result = await detector.validate(
      "This is a normal response about the codebase.",
    );
    expect(result.status).toBe("pass");
  });

  it("should retry on empty", async () => {
    const detector = new HallucinationDetector();
    const result = await detector.validate("");
    expect(result.status).toBe("retry");
  });

  it("should warn on low word diversity", async () => {
    const detector = new HallucinationDetector();
    const result = await detector.validate(
      "the the the the the the the the the the the the the the the the the the the",
    );
    expect(result.status).toBe("warn");
  });

  it("should pass when no judge provider is configured even with decisions", async () => {
    const detector = new HallucinationDetector();
    detector.getConsistencyCheck().trackDecision("use postgres", "agent");
    const result = await detector.validate("I will use MySQL from now on");
    expect(result.status).toBe("pass");
  });

  it("should warn when judge detects contradiction", async () => {
    const mockProvider = {
      model: "judge",
      contextWindow: 4096,
      chat: async function* () {
        yield {
          type: "text" as const,
          content: '{"contradicts": true, "reason": "switched DB"}',
        };
        yield { type: "done" as const, finishReason: "stop" as const };
      },
      countTokens: () => 10,
    };
    const detector = new HallucinationDetector(undefined, mockProvider as any);
    detector.getConsistencyCheck().trackDecision("use postgres", "agent");
    const result = await detector.validate("I will use MySQL from now on");
    expect(result.status).toBe("warn");
    expect(result.reason).toContain("switched DB");
  });

  it("should pass when judge detects no contradiction", async () => {
    const mockProvider = {
      model: "judge",
      contextWindow: 4096,
      chat: async function* () {
        yield { type: "text" as const, content: '{"contradicts": false}' };
        yield { type: "done" as const, finishReason: "stop" as const };
      },
      countTokens: () => 10,
    };
    const detector = new HallucinationDetector(undefined, mockProvider as any);
    detector.getConsistencyCheck().trackDecision("use postgres", "agent");
    const result = await detector.validate(
      "The postgres schema looks fine, no changes are needed for the migration.",
    );
    expect(result.status).toBe("pass");
  });

  it("should degrade to pass when judge errors", async () => {
    const mockProvider = {
      model: "judge",
      contextWindow: 4096,
      chat: async function* () {
        throw new Error("provider down");
        yield { type: "done" as const, finishReason: "stop" as const };
      },
      countTokens: () => 10,
    };
    const detector = new HallucinationDetector(undefined, mockProvider as any);
    detector.getConsistencyCheck().trackDecision("use postgres", "agent");
    const result = await detector.validate("I will use MySQL from now on");
    expect(result.status).toBe("pass");
  });
});
