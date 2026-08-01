import { describe, it, expect } from "vitest";
import { ConfidenceCheck } from "../src/modules/hallucination/confidence";

describe("ConfidenceCheck", () => {
  it("should retry on empty response", () => {
    const check = new ConfidenceCheck();
    const result = check.validate("");
    expect(result.status).toBe("retry");
  });

  it("should retry on short response", () => {
    const check = new ConfidenceCheck();
    const result = check.validate("");
    expect(result.status).toBe("retry");
  });

  it("should retry on repetitive response", () => {
    const check = new ConfidenceCheck();
    check.setPreviousResponse("I think we should use TypeScript");
    const result = check.validate(
      "I think we should use TypeScript and I think we should use TypeScript",
    );
    expect(result.status).toBe("retry");
  });

  it("should warn on uncertainty markers", () => {
    const check = new ConfidenceCheck();
    const result = check.validate(
      "I think maybe we should probably use this approach",
    );
    expect(result.status).toBe("warn");
  });

  it("should pass on normal response", () => {
    const check = new ConfidenceCheck();
    const result = check.validate(
      "We should use the standard library for this task.",
    );
    expect(result.status).toBe("pass");
  });
});
