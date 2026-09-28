import { describe, it, expect, vi } from "vitest";
import {
  questionTool,
  splitByMemory,
  collectMemoryHits,
  extractKeywords,
  MAX_QUESTIONS_PER_CALL,
} from "../../src/tools/question";
import type { PromptIO } from "../../src/tools/prompt-io";

// Hermetic by default: stub the memory pre-check so tests never depend on
// (or touch) the developer's real ~/.mma memory.
const noMemory = { memorySearch: () => [] as string[] };
const ctx = { ...noMemory } as any;

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
    const result = await questionTool.handler({ promptIO: io, ...noMemory } as any, {
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
    const result = await questionTool.handler({ promptIO: io, ...noMemory } as any, {
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

describe("questionTool memory pre-check", () => {
  it("splitByMemory separates known from unknown questions", () => {
    const { known, unknown } = splitByMemory(
      [{ question: "Which city?" }, { question: "Favorite color?" }],
      (spec) => (spec.question.includes("city") ? ["[facts] city = Kazan"] : []),
    );
    expect(known).toHaveLength(1);
    expect(known[0].hits).toEqual(["[facts] city = Kazan"]);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].question).toBe("Favorite color?");
  });

  it("skips prompting when memory answers everything", async () => {
    const io = fakeIO();
    const result = await questionTool.handler(
      { promptIO: io, memorySearch: () => ["[facts] city = Kazan"] } as any,
      { questions: [{ question: "Which city?" }] },
    );
    expect(result.success).toBe(true);
    expect(io.askText).not.toHaveBeenCalled();
    expect(io.askChoice).not.toHaveBeenCalled();
    expect(result.output).toContain("Kazan");
  });

  it("asks only unknown questions and reports the known ones", async () => {
    const io = fakeIO({ askText: vi.fn(async () => "blue") });
    const result = await questionTool.handler(
      {
        promptIO: io,
        memorySearch: (spec: { question: string }) =>
          spec.question.includes("city") ? ["[facts] city = Kazan"] : [],
      } as any,
      { questions: [{ question: "Which city?" }, { question: "Favorite color?" }] },
    );
    expect(result.success).toBe(true);
    expect(io.askText).toHaveBeenCalledOnce();
    expect(result.output).toContain("blue");
    expect(result.output).toContain("Kazan");
  });

  it("caps the batch at MAX_QUESTIONS_PER_CALL with a re-call note", async () => {
    const askText = vi.fn(async () => "x");
    const io = fakeIO({ askText });
    const result = await questionTool.handler({ promptIO: io, ...noMemory } as any, {
      questions: Array.from({ length: MAX_QUESTIONS_PER_CALL + 2 }, (_, i) => ({
        question: `Q${i}?`,
      })),
    });
    expect(result.success).toBe(true);
    expect(askText).toHaveBeenCalledTimes(MAX_QUESTIONS_PER_CALL);
    expect(result.output).toContain(String(MAX_QUESTIONS_PER_CALL));
  });
});

describe("collectMemoryHits keyword overlap", () => {
  const bikeLine = "bike_type = MTB - горный велосипед для трейлов, бюджет 100-200к";
  /** Substring search like MemoryStore.search, over one memory line. */
  const searchLine = (line: string) => (kw: string) =>
    line.toLowerCase().includes(kw.toLowerCase()) ? [{ file: "preferences", match: line }] : [];

  it("extractKeywords drops short words, punctuation and dupes", () => {
    expect(extractKeywords("Какой тип подвески, тип?", undefined)).toEqual([
      "какой",
      "подвески",
    ]);
  });

  it("matches on ≥2 shared keywords (session Q4: budget question)", () => {
    const hits = collectMemoryHits(searchLine(bikeLine), {
      question: "Какой бюджет ты готов потратить на велосипед?",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("бюджет 100-200к");
  });

  it("ignores single generic-word overlap (session Q1: suspension question)", () => {
    // No shared keywords at all: memory knows "MTB" in general but says
    // nothing about suspension type, so the user must be asked.
    const hits = collectMemoryHits(searchLine(bikeLine), {
      question: "Какой тип подвески ты предпочитаешь?",
      options: [
        { label: "Хардтейл", description: "Только вилка" },
        { label: "Двухподвес", description: "Полная подвеска" },
      ],
    });
    expect(hits).toHaveLength(0);
  });

  it("uses option labels in the overlap (frame size question)", () => {
    const line = "frame = рама 17 дюймов, размер средний";
    const hits = collectMemoryHits(searchLine(line), {
      question: "Какой размер?",
      options: [{ label: "Средний 17-17.5", description: "рама 17 дюймов" }],
    });
    expect(hits).toHaveLength(1);
  });

  it("filters out single-keyword overlap (too easy to be coincidence)", () => {
    // Only "бюджет" is shared — one generic word must not skip the question.
    const hits = collectMemoryHits(searchLine(bikeLine), {
      question: "Бюджет?",
    });
    expect(hits).toHaveLength(0);
  });

  it("fail-open: search errors never block", () => {
    const hits = collectMemoryHits(
      () => {
        throw new Error("disk gone");
      },
      { question: "Какой бюджет?" },
    );
    expect(hits).toEqual([]);
  });
});
