import { describe, it, expect } from "vitest";
import { questionTool } from "../../src/tools/question";

const ctx = {} as any;

describe("questionTool", () => {
  it("has correct definition", () => {
    expect(questionTool.name).toBe("question");
    expect(questionTool.description).toBeTruthy();
    expect(questionTool.interactive).toBe(true);
    expect(questionTool.tags).toContain("core");
    const props = (questionTool.parameters as any).properties;
    expect(props.questions).toBeTruthy();
    expect(props.question).toBeTruthy(); // legacy format
  });

  it("fails when no questions are provided", async () => {
    const result = await questionTool.handler(ctx, {});
    expect(result.success).toBe(false);
    expect(result.output).toContain("No questions");
  });

  it("fails on an empty questions array", async () => {
    const result = await questionTool.handler(ctx, { questions: [] });
    expect(result.success).toBe(false);
  });

  it("fails when question items lack a question string", async () => {
    const result = await questionTool.handler(ctx, {
      questions: [{ header: "nope" }, { question: "   " }],
    });
    expect(result.success).toBe(false);
  });

  it("fails when every option entry is malformed", async () => {
    // All options invalid → question treated as malformed → no questions left.
    const result = await questionTool.handler(ctx, {
      questions: [
        {
          question: "Pick one",
          options: [{ label: "A" }, { description: "no label" }, "junk"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
