import { t } from "../i18n/index";
import { askUser } from "./user-input";
import type { InputOption } from "./user-input";
import type { ToolContext, ToolDefinition } from "./types";
import { MemoryStore } from "../modules/memory/store";
import { globalMemoryDir } from "../config/paths";

export interface QuestionSpec {
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
- Omit "options" for a free-text question
- Before asking, the tool checks agent memory itself: questions memory
  already answers are skipped (reported back, not asked) — never ask what
  is already known
- Answers live only in the current session; nothing is written to memory.
  Call "remember" separately to persist something, and only when asked to
- At most 3 unknown questions are asked per call; keep batches small`;

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

/** Max unknown questions asked per call — small models lose track of larger batches. */
export const MAX_QUESTIONS_PER_CALL = 3;

/** Token bound for the memory pre-check: hits reported per question. */
const MAX_MEMORY_HITS = 2;
const MAX_HIT_CHARS = 200;

export interface KnownQuestion {
  spec: QuestionSpec;
  hits: string[];
}

/**
 * Split specs into memory-known (report, do not ask) vs unknown (ask).
 * Pure over an injected lookup fn so tests never touch the real memory dir.
 */
export function splitByMemory(
  specs: QuestionSpec[],
  lookup: (spec: QuestionSpec) => string[],
): { known: KnownQuestion[]; unknown: QuestionSpec[] } {
  const known: KnownQuestion[] = [];
  const unknown: QuestionSpec[] = [];
  for (const spec of specs) {
    const hits = lookup(spec);
    if (hits.length > 0) known.push({ spec, hits });
    else unknown.push(spec);
  }
  return { known, unknown };
}

/**
 * Significant words of a text: lowercased, unicode-split, length ≥ 4.
 * Shorter words ("тип", "для", "что") are noise for overlap matching.
 */
export function extractKeywords(...texts: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 4) out.add(word);
    }
  }
  return [...out];
}

/**
 * A memory line counts as an answer only if it shares at least this many
 * distinct keywords with the question. A single shared word ("какой",
 * "город") is usually coincidence — skipping on it would answer from stale
 * data instead of asking. Precision beats recall here: a miss just asks.
 */
const MIN_KEYWORD_OVERLAP = 2;

interface MemoryHit {
  file: string;
  match: string;
}

/**
 * Keyword-overlap memory lookup over an injected per-keyword search.
 * Pure — the production wiring (`lookupMemory`) passes `MemoryStore.search`.
 */
export function collectMemoryHits(
  searchOne: (keyword: string) => MemoryHit[],
  spec: QuestionSpec,
): string[] {
  const keywords = extractKeywords(
    spec.question,
    spec.header,
    ...(spec.options ?? []).flatMap((o) => [o.label, o.description]),
  );
  if (keywords.length === 0) return [];
  const lines = new Map<string, { text: string; matched: Set<string> }>();
  for (const kw of keywords) {
    let hits: MemoryHit[];
    try {
      hits = searchOne(kw);
    } catch {
      continue;
    }
    for (const r of hits) {
      const key = `${r.file}\n${r.match}`;
      let entry = lines.get(key);
      if (!entry) {
        entry = { text: `[${r.file}] ${r.match}`, matched: new Set() };
        lines.set(key, entry);
      }
      entry.matched.add(kw);
    }
  }
  return [...lines.values()]
    .filter((e) => e.matched.size >= MIN_KEYWORD_OVERLAP)
    .slice(0, MAX_MEMORY_HITS)
    .map((e) => e.text.slice(0, MAX_HIT_CHARS));
}

/**
 * Fail-open memory lookup: unreadable/missing memory never blocks asking.
 * Returns short `file: match` snippets, token-capped.
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
 * Test seam: a `memorySearch` on the context stubs the memory pre-check
 * (same override pattern as `ToolContext.agentFactory` — Bun module mocks
 * are process-global, so plain vi.mock cannot be used here).
 */
function resolveSearch(ctx: ToolContext): (spec: QuestionSpec) => string[] {
  const stub = (ctx as unknown as { memorySearch?: (spec: QuestionSpec) => string[] })
    .memorySearch;
  return typeof stub === "function" ? stub : lookupMemory;
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

    // Memory pre-check: never ask what memory already answers. Known
    // questions are reported back, not asked. Nothing is written to memory —
    // answers live only in this session (persist via "remember" if asked to).
    const { known, unknown } = splitByMemory(questions, resolveSearch(ctx));

    // Batch cap: ask at most MAX_QUESTIONS_PER_CALL, note the rest so the
    // model calls again instead of losing questions silently.
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
    parts.push(t("tool.question.session_only"));
    if (truncated > 0) {
      parts.push(
        t("tool.question.batch_truncated", {
          shown: MAX_QUESTIONS_PER_CALL,
          total: unknown.length,
        }),
      );
    }
    return { success: true, output: parts.join(" ") };
  },
};
