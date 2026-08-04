import { describe, it, expect } from "vitest";
import { HallucinationDetector } from "../src/modules/hallucination/detector";

describe("HallucinationDetector", () => {
  it("should pass on normal response", () => {
    const detector = new HallucinationDetector();
    const result = detector.validate(
      "This is a normal response about the codebase.",
    );
    expect(result.status).toBe("pass");
  });

  it("should retry on empty", () => {
    const detector = new HallucinationDetector();
    const result = detector.validate("");
    expect(result.status).toBe("retry");
  });

  it("should warn on low word diversity", () => {
    const detector = new HallucinationDetector();
    const result = detector.validate(
      "the the the the the the the the the the the the the the the the the the the",
    );
    expect(result.status).toBe("warn");
  });
});
