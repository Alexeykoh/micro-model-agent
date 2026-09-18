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
    const sentence =
      "The system should use TypeScript for this project because it provides strong typing better tooling and reliable refactoring support across the entire codebase for long term maintainability";
    check.setPreviousResponse(sentence);
    const result = check.validate(sentence + " as we already decided earlier in this session");
    expect(result.status).toBe("retry");
  });

  it("does not flag repeated short answers as repetition", () => {
    const check = new ConfidenceCheck();
    check.setPreviousResponse("The build passes and all tests are green.");
    const result = check.validate("The build passes and all tests are green.");
    expect(result.status).not.toBe("retry");
  });

  it("does not flag a long answer as repetition after a short previous answer", () => {
    const check = new ConfidenceCheck();
    check.setPreviousResponse("Done.");
    const result = check.validate(
      "Done. The refactoring is complete and all of the requested changes have been applied to every file in the project with full coverage",
    );
    expect(result.status).not.toBe("retry");
  });

  it("should warn on low word diversity", () => {
    const check = new ConfidenceCheck();
    const result = check.validate(
      "the the the the the the the the the the the the the the the the the the",
    );
    expect(result.status).toBe("warn");
  });

  it("does not flag short replies (greeting, acknowledgement, fragment)", () => {
    const check = new ConfidenceCheck();
    expect(check.validate("Привет! Чем могу помочь?").status).toBe("pass");
    expect(check.validate("Готово").status).toBe("pass");
    expect(check.validate("Done.").status).toBe("pass");
    expect(check.validate("The answer is").status).toBe("pass");
  });

  it("should pass on normal response", () => {
    const check = new ConfidenceCheck();
    const result = check.validate("We should use the standard library for this task.");
    expect(result.status).toBe("pass");
  });
});
