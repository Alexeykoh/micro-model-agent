import { t } from "../i18n/index";
import { askUser } from "./user-input";
import type { InputOption } from "./user-input";
import type { ToolDefinition } from "./types";

interface QuestionSpec {
  question: string;
  header?: string;
  options?: InputOption[];
  multiple?: boolean;
  custom?: boolean;
}

const DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- When "custom" is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set "multiple": true to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- Execution blocks until the user answers every question
- Omit "options" for a free-text question`;

function isOption(val: unknown): val is InputOption {
  if (!val || typeof val !== "object") return false;
  const opt = val as Record<string, unknown>;
  return typeof opt.label === "string" && typeof opt.description === "string";
}

function normalizeQuestions(args: Record<string, unknown>): QuestionSpec[] {
  const raw = args.questions;
  if (Array.isArray(raw)) {
    const specs: QuestionSpec[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const q = item as Record<string, unknown>;
      if (typeof q.question !== "string" || !q.question.trim()) continue;
      const options = Array.isArray(q.options) ? q.options.filter(isOption) : undefined;
      // An explicitly provided options array with no valid entries is a
      // malformed call — skip the question instead of blocking on stdin.
      if (Array.isArray(q.options) && options!.length === 0) continue;
      specs.push({
        question: q.question,
        header: typeof q.header === "string" ? q.header : undefined,
        options,
        multiple: q.multiple === true,
        custom: q.custom === false ? false : undefined,
      });
    }
    return specs;
  }
  // Legacy format: { question: "..." } — plain free-text question.
  if (typeof args.question === "string" && args.question.trim()) {
    return [{ question: args.question }];
  }
  return [];
}

export const questionTool: ToolDefinition = {
  name: "question",
  icon: "❓",
  description: DESCRIPTION,
  tags: ["core"],
  interactive: true,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "Questions to ask",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "Complete question" },
            header: {
              type: "string",
              description: "Very short label (max 30 chars)",
            },
            options: {
              type: "array",
              description: "Available choices; omit for a free-text question",
              items: {
                type: "object",
                properties: {
                  label: {
                    type: "string",
                    description: "Display text (1-5 words, concise)",
                  },
                  description: {
                    type: "string",
                    description: "Explanation of choice",
                  },
                },
                required: ["label", "description"],
              },
            },
            multiple: {
              type: "boolean",
              description: "Allow selecting multiple choices",
            },
            custom: {
              type: "boolean",
              description: "Allow typing a custom answer (default: true)",
            },
          },
          required: ["question"],
        },
      },
      question: {
        type: "string",
        description: "Legacy single free-text question",
      },
    },
  },
  handler: async (ctx, args) => {
    if (ctx.exitOnComplete) {
      return { success: false, output: t("tool.interactive_disabled") };
    }
    const questions = normalizeQuestions(args);
    if (questions.length === 0) {
      return { success: false, output: t("tool.question.no_questions") };
    }

    const answers: string[][] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const progress =
        questions.length > 1
          ? t("tool.question.progress", {
              current: i + 1,
              total: questions.length,
            })
          : undefined;
      answers.push(
        await askUser(
          q.question,
          {
            header: q.header,
            options: q.options,
            multiple: q.multiple,
            custom: q.custom,
            progress,
          },
          ctx.promptIO,
        ),
      );
    }

    const formatted = questions
      .map(
        (q, i) =>
          `"${q.question}"="${answers[i].length ? answers[i].join(", ") : t("tool.question.unanswered")}"`,
      )
      .join(", ");
    return {
      success: true,
      output: t("tool.question.answered", { formatted }),
    };
  },
};
