// Deterministic memory quality gate (spec 2026-11-03-memory-validator-design).
// Runs at save time: a garbage or duplicate line must never reach `*.md`, because
// the tail of those files becomes system-prompt input for the next session.
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface ValidationResult {
  accepted: boolean;
  reason?: string;
}

export interface ValidatorOptions {
  enabled?: boolean;
  minChars?: number;
  minWords?: number;
  similarityThreshold?: number;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was",
  "were", "will", "would", "can", "could", "should", "not", "but", "you", "your",
  "use", "when", "then", "than", "there", "here", "have", "has", "had", "been",
  "и", "в", "во", "не", "на", "с", "со", "к", "ко", "по", "за", "из", "от", "до",
  "для", "что", "как", "это", "этот", "эта", "эти", "тот", "при", "или", "но",
  "же", "бы", "был", "была", "были", "быть", "есть", "уже", "если", "так",
  "там", "тут", "мы", "вы", "они", "она", "он", "его", "её", "их", "все",
]);

const GARBAGE: RegExp[] = [
  /^[-*_]{1,3}$/,
  /^\[[ xX]?\]/,
  /^#{1,6}\s/,
  /^\*\*[^*]{1,60}\*\*:?$/,
  /^[[\](){}<>]+$/,
  /^\d+$/,
  /^[a-zA-Zа-яА-ЯёЁ]$/,
];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function tokens(text: string): Set<string> {
  return new Set(words(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Strips the `- **ts** - ` prefix and rule labels before comparisons. */
function normalizeEntry(raw: string): string {
  return raw
    .replace(/^-\s+\*\*[^*]+\*\*\s*-\s*/, "")
    .replace(/\*\*(pattern|cause|solution):\*\*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class MemoryValidator {
  private readonly memoryDir: string;
  private readonly minChars: number;
  private readonly minWords: number;
  private readonly threshold: number;

  constructor(memoryDir: string, opts: ValidatorOptions = {}) {
    this.memoryDir = memoryDir;
    this.minChars = opts.minChars ?? 15;
    this.minWords = opts.minWords ?? 3;
    this.threshold = opts.similarityThreshold ?? 0.8;
  }

  validate(category: string, entry: string): ValidationResult {
    const text = normalizeEntry(entry);
    const bad = this.garbage(text);
    if (bad) return { accepted: false, reason: bad };

    if (category !== "preferences") {
      // `errors` entries are diagnostic: a short cause is still better than
      // nothing, so they only need a longer floor than the generic minimum.
      const min = category === "errors" ? Math.max(this.minChars, 20) : this.minChars;
      if (text.length < min) {
        return { accepted: false, reason: `too short (min ${min} chars)` };
      }
      const meaningful = words(text);
      if (meaningful.length < this.minWords && !(category === "facts" && text.length >= min)) {
        return { accepted: false, reason: `too few meaningful words (min ${this.minWords})` };
      }
    }

    const existing = this.existing(category);
    const norm = text.toLowerCase();
    if (existing.some((e) => e.toLowerCase() === norm)) {
      return { accepted: false, reason: "duplicate entry" };
    }
    const mine = tokens(text);
    for (const old of existing) {
      if (jaccard(mine, tokens(old)) >= this.threshold) {
        return { accepted: false, reason: "near-duplicate entry" };
      }
    }
    return { accepted: true };
  }

  validateRule(
    category: string,
    pattern: string,
    cause: string,
    solution: string,
  ): ValidationResult {
    const fields: Array<[string, string]> = [
      ["pattern", pattern],
      ["cause", cause],
      ["solution", solution],
    ];
    for (const [name, value] of fields) {
      const text = normalizeEntry(value);
      const bad = this.garbage(text);
      if (bad) return { accepted: false, reason: `${name}: ${bad}` };
      if (text.length < 5) return { accepted: false, reason: `${name}: too short` };
    }
    return this.validate(category, `pattern: ${pattern} cause: ${cause} solution: ${solution}`);
  }

  private garbage(text: string): string | null {
    if (!text) return "empty entry";
    for (const re of GARBAGE) if (re.test(text)) return "garbage fragment";
    return null;
  }

  /** Existing entries of a category, newest last; a missing file is empty. */
  private existing(category: string): string[] {
    const path = join(this.memoryDir, `${category}.md`);
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("- "))
        .map(normalizeEntry)
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}
