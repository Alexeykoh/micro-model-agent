/** Тул вопросов юзеру: меню, memory pre-check, батч-cap, сессионные ответы. */
import { t } from "../i18n/index";
import { askUser } from "./user-input";
import type { InputOption } from "./user-input";
import type { ToolContext, ToolDefinition } from "./types";
import { MemoryStore } from "../modules/memory/store";
import { globalMemoryDir } from "../config/paths";

/** Спецификация вопроса: текст, заголовок, опции, мультивыбор, кастом. */
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

/** Проверяет форму опции (label + description — строки). */
function isOption(val: unknown): val is InputOption {
  if (!val || typeof val !== "object") return false;
  const opt = val as Record<string, unknown>;
  return typeof opt.label === "string" && typeof opt.description === "string";
}

/** Нормализует args в спеки (массив + legacy `{ question }`). Битые — пропуск. */
function normalizeQuestions(args: Record<string, unknown>): QuestionSpec[] {
  const raw = args.questions;
  if (Array.isArray(raw)) {
    const specs: QuestionSpec[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const q = item as Record<string, unknown>;
      if (typeof q.question !== "string" || !q.question.trim()) continue;
      const options = Array.isArray(q.options) ? q.options.filter(isOption) : undefined;
      // Явно данный массив опций без валидных записей — malformed вызов:
      // вопрос пропустить, а не висеть на stdin.
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
  // Legacy-формат: { question: "..." } — plain free-text вопрос.
  if (typeof args.question === "string" && args.question.trim()) {
    return [{ question: args.question }];
  }
  return [];
}

/** Максимум незнакомых вопросов за вызов — большие батчи малые модели теряют. */
export const MAX_QUESTIONS_PER_CALL = 3;

/** Токенный bound memory pre-check: хиты репортятся повопросно. */
const MAX_MEMORY_HITS = 2;
const MAX_HIT_CHARS = 200;

/** Вопрос, закрытый памятью: спека + найденные сниппеты. */
export interface KnownQuestion {
  spec: QuestionSpec;
  hits: string[];
}

/**
 * Делит спеки на известные памяти (репорт, не спрашивать) и незнакомые.
 * Чистая через инжектируемый lookup — тесты не трогают реальный memory dir.
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
 * Сигнатура вопроса для анти-петли: нормализованный текст (регистр, пунктуация,
 * пробелы). Опции/заголовок не входят — модель часто переформулирует варианты,
 * но намерение то же.
 */
export function questionSignature(spec: QuestionSpec): string {
  return spec.question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Анти-петля: вопросы, уже отчёченные как «известные памяти» в этой сессии.
 * WeakMap по ctx (стабилен на сессию) — состояние не течёт между сессиями и
 * убирается сборщиком. `true`, если хоть один из `known` уже репортился, т.е.
 * модель переспрашивает то, что память уже закрыла.
 */
const reportedKnown = new WeakMap<object, Set<string>>();

export function markRepeatedKnown(ctx: object, known: KnownQuestion[]): boolean {
  if (known.length === 0) return false;
  let seen = reportedKnown.get(ctx);
  if (!seen) {
    seen = new Set<string>();
    reportedKnown.set(ctx, seen);
  }
  let repeated = false;
  for (const k of known) {
    const sig = questionSignature(k.spec);
    if (seen.has(sig)) repeated = true;
    else seen.add(sig);
  }
  return repeated;
}

/**
 * Значимые слова текста: lowercase, unicode-разбивка, длина ≥ 4. Короче
 * ("тип", "для", "что") — шум для overlap-мэтчинга.
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
 * Строка памяти считается ответом, только если делит со вопросом не меньше
 * стольких distinct keywords. Одно общее слово ("какой", "город") — обычно
 * совпадение: пропуск на нём ответил бы из stale-данных вместо вопроса.
 * Precision важнее recall: промах просто спросит.
 */
const MIN_KEYWORD_OVERLAP = 2;

/** Найденное в памяти: файл + совпадение. */
interface MemoryHit {
  file: string;
  match: string;
}

/**
 * Keyword-overlap поиск по памяти через инжектируемый покейвордный поиск.
 * Чистая — прод-обвязка (`lookupMemory`) передаёт `MemoryStore.search`.
 *
 * Слова опций (label/description) в overlap НЕ входят: опции — это варианты
 * ответа, а не намерение вопроса. Их терминология (напр. "TypeScript" в
 * вариантах стека) часто случайно пересекается с профилем пользователя и
 * глушила проектные вопросы, на которые память на самом деле не отвечает
 * (наблюдалось: вопрос «какой стек для лендинга?» подавлялся строкой
 * «Стек: JavaScript/TypeScript, Python» из facts.md). Precision важнее recall:
 * ложное подавление зацикливает слабую модель, лишний вопрос — безопасен.
 */
export function collectMemoryHits(
  searchOne: (keyword: string) => MemoryHit[],
  spec: QuestionSpec,
): string[] {
  const keywords = extractKeywords(spec.question, spec.header);
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
