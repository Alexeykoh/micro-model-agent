/** Разбор args, память-пречек и анти-петля тула вопросов (чистые хелперы). */
import type { InputOption } from "./user-input";

/** Спецификация вопроса: текст, заголовок, опции, мультивыбор, кастом. */
export interface QuestionSpec {
  question: string;
  header?: string;
  options?: InputOption[];
  multiple?: boolean;
  custom?: boolean;
}

/** Проверяет форму опции (label + description — строки). */
function isOption(val: unknown): val is InputOption {
  if (!val || typeof val !== "object") return false;
  const opt = val as Record<string, unknown>;
  return typeof opt.label === "string" && typeof opt.description === "string";
}

/** Нормализует args в спеки (массив + legacy `{ question }`). Битые — пропуск. */
export function normalizeQuestions(args: Record<string, unknown>): QuestionSpec[] {
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
