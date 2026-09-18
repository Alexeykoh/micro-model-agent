import { describe, it, expect, vi } from "vitest";
import { questionTool } from "../../src/tools/question";
import type { PromptIO } from "../../src/tools/prompt-io";

const ctx = {} as any;

function fakeIO(overrides: Partial<PromptIO> = {}): PromptIO {
  return {
    askText: vi.fn(async () => "typed answer"),
    askChoice: vi.fn(async () => [0]),
    ...overrides,
  };
}

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

  it("returns the label selected through promptIO", async () => {
    const io = fakeIO({ askChoice: vi.fn(async () => [1]) });
    const result = await questionTool.handler({ promptIO: io } as any, {
      questions: [
        {
          question: "Pick a framework",
          options: [
            { label: "React", description: "Library" },
            { label: "Vue", description: "Framework" },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("Vue");
    expect(io.askChoice).toHaveBeenCalledOnce();
  });

  it("returns free text typed through promptIO", async () => {
    const io = fakeIO({ askText: vi.fn(async () => "hello") });
    const result = await questionTool.handler({ promptIO: io } as any, {
      questions: [{ question: "What is your name?" }],
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
    expect(io.askText).toHaveBeenCalledOnce();
  });

  it("short-circuits in exitOnComplete mode without prompting", async () => {
    const io = fakeIO();
    const result = await questionTool.handler({ promptIO: io, exitOnComplete: true } as any, {
      questions: [{ question: "Q" }],
    });
    expect(result.success).toBe(false);
    expect(io.askText).not.toHaveBeenCalled();
    expect(io.askChoice).not.toHaveBeenCalled();
  });
});
