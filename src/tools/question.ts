/** Тул вопросов юзеру: меню, memory pre-check, батч-cap, сессионные ответы. */
import { t } from "../i18n/index";
import { askUser } from "./user-input";
import type { ToolContext, ToolDefinition } from "./types";
import { MemoryStore } from "../modules/memory/store";
import { globalMemoryDir } from "../config/paths";
import {
  MAX_QUESTIONS_PER_CALL,
  collectMemoryHits,
  markRepeatedKnown,
  normalizeQuestions,
  splitByMemory,
} from "./question-format";
import type { QuestionSpec } from "./question-format";

// Публичный API тула: хелперы разбора/памяти живут в question-format, но
// реэкспорт сохраняет прежние импорты из `tools/question` (тесты, модули).
export type { KnownQuestion, QuestionSpec } from "./question-format";
export {
  MAX_QUESTIONS_PER_CALL,
  collectMemoryHits,
  extractKeywords,
  markRepeatedKnown,
  questionSignature,
  splitByMemory,
} from "./question-format";

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
- Omit "options" for a free-text question
- Never ask choice questions as a plain-text list in your reply — always call
  this tool (it renders interactive buttons and blocks until answered).
  When the user asks for a Q&A session with options, use this tool for every
  question, not chat text
- Before asking, the tool checks agent memory itself: questions memory
  already answers are skipped (reported back, not asked) — never ask what
  is already known
- Answers live only in the current session; nothing is written to memory.
  Call "remember" separately to persist something, and only when asked to
- At most 3 unknown questions are asked per call; keep batches small`;

/**
 * Fail-open поиск по памяти: нечитаемая/отсутствующая память вопрос не блокирует.
 * Возврат — короткие `file: match`-сниппеты, токенно ограниченные.
 */
function lookupMemory(spec: QuestionSpec): string[] {
  try {
    const store = new MemoryStore(globalMemoryDir());
    return collectMemoryHits((kw) => store.search(kw), spec);
  } catch {
    return [];
  }
}

/**
 * Тестовый шов: `memorySearch` на контексте стабит memory pre-check (тот же
 * override-паттерн, что `ToolContext.agentFactory` — моки Bun-модулей глобальны
 * на процесс, plain vi.mock тут не годится).
 */
function resolveSearch(ctx: ToolContext): (spec: QuestionSpec) => string[] {
  const stub = (ctx as unknown as { memorySearch?: (spec: QuestionSpec) => string[] })
    .memorySearch;
  return typeof stub === "function" ? stub : lookupMemory;
}

/** Тул вопросов: выбор/мультивыбор/free-text, memory pre-check, батч-cap 3. */
export const questionTool: ToolDefinition = {
  name: "question",
  security: { caps: [{ interactive: true }] },
  icon: "❓",
  description: DESCRIPTION,
  tags: ["core"],
  // Интерактивные тулы переживают сужение тегов: спросить модель должна уметь
  // всегда, при любом типе задачи (P5 auto-narrowing).
  alwaysOn: true,
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

    // Memory pre-check: известное памяти не спрашивать. Известные вопросы —
    // репорт, не опрос. В память ничего не пишется: ответы живут только в сессии
    // (persist — отдельным "remember" по просьбе).
    const { known, unknown } = splitByMemory(questions, resolveSearch(ctx));

    // Батч-cap: не больше MAX_QUESTIONS_PER_CALL за раз, остаток — пометкой,
    // чтобы модель довызвала, а не потеряла вопросы молча.
    const truncated = unknown.length - MAX_QUESTIONS_PER_CALL;
    const toAsk = truncated > 0 ? unknown.slice(0, MAX_QUESTIONS_PER_CALL) : unknown;

    const answers: string[][] = [];
    for (let i = 0; i < toAsk.length; i++) {
      const q = toAsk[i];
      const progress =
        toAsk.length > 1
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

    // Анти-петля: та же память-известная тема, запрошенная повторно в сессии
    // (наблюдалось: qwen3.5-9b трижды звал question с одним смыслом, получал
    // memory_known и в итоге «сдавался», выливая вопрос текстом).
    const repeatedKnown = markRepeatedKnown(ctx, known);

    const parts: string[] = [];
    if (toAsk.length > 0) {
      const formatted = toAsk
        .map(
          (q, i) =>
            `"${q.question}"="${answers[i].length ? answers[i].join(", ") : t("tool.question.unanswered")}"`,
        )
        .join(", ");
      parts.push(t("tool.question.answered", { formatted }));
    } else {
      parts.push(t("tool.question.memory_only"));
    }
    if (known.length > 0) {
      const formatted = known
        .map((k) => `"${k.spec.question}"="${k.hits.join("; ")}"`)
        .join(", ");
      parts.push(t("tool.question.memory_known", { formatted }));
    }
    if (repeatedKnown) {
      parts.push(t("tool.question.memory_repeat"));
    }
    parts.push(t("tool.question.session_only"));
    if (truncated > 0) {
      parts.push(
        t("tool.question.batch_truncated", {
          shown: MAX_QUESTIONS_PER_CALL,
          total: unknown.length,
        }),
      );
    }
    // display:"" гасит UI-эхо (tool-batch предпочитает display и пропускает
    // пустые): модели — полный output в role:"tool", чату — только блок вопроса
    // с ↳-ответами. Текст output — model-facing директивы (сессия/память/батч),
    // не контент юзера: и verbose идёт через tool_end, не meta.
    return { success: true, output: parts.join(" "), display: "" };
  },
};
