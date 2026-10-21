// Нормализация Markdown, которую строгий CommonMark-парсер (smd.js) оставляет
// сырым текстом: GFM-таблицы без внешних `|`, списки `1)`, заголовки `##X` без
// пробела. Чистый модуль без DOM; состояние — для потокового пути (одна строка
// lookahead, чтобы опознать таблицу по следующей delimiter-строке).

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})([^\s#].*)$/;
const OL_RE = /^(\s*)(\d+)\)(\s+)(.*)$/;
// Разделитель таблицы: `---`, `:--:`, `---|---`, `| --- | --- |`; обязан иметь `|`.
const DELIMITER_RE = /^\s*\|?\s*:?-{1,}:?(\s*\|\s*:?-{1,}:?)+\s*\|?\s*$/;
// Строка-строка таблицы: содержит `|` и не является списком/цитатой/фенсом.
const ROW_RE = /^(?!\s*[-*+]\s)(?!\s*\d+[.)]\s)(?!\s*>)(?!\s*(```|~~~)).*\|.*$/;

function hasUnescapedPipe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "|" && s[i - 1] !== "\\") return true;
  }
  return false;
}

/** Добавляет внешние `|` строке таблицы, если их нет. */
function ensureOuterPipes(line: string): string {
  let s = line.trim();
  if (!s.startsWith("|")) s = "| " + s;
  if (!s.endsWith("|")) s = s + " |";
  return s;
}

function isDelimiter(line: string): boolean {
  return hasUnescapedPipe(line) && DELIMITER_RE.test(line);
}

/**
 * Строчный нормализатор с одной строкой «удержания» (lookahead). `push` отдаёт
 * только завершённые строки; последняя недописанная остаётся внутри до `flush`.
 */
export class MdNormalizer {
  private buf = "";
  private held: string | null = null;
  private tableActive = false;
  private fence = false;

  /** Принимает чанк, возвращает нормализованный прирост (завершённые строки). */
  push(chunk: string): string {
    this.buf += chunk == null ? "" : String(chunk);
    let out = "";
    let idx = this.buf.indexOf("\n");
    while (idx !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (this.held !== null) out += this.decide(this.held, line) + "\n";
      this.held = line;
      idx = this.buf.indexOf("\n");
    }
    return out;
  }

  /** Отдаёт удержанную строку и хвост без перевода строки. */
  flush(): string {
    let out = "";
    if (this.held !== null) {
      out += this.decide(this.held, null) + "\n";
      this.held = null;
    }
    if (this.buf) {
      out += this.decideInline(this.buf);
      this.buf = "";
    }
    return out;
  }

  /** Решение по завершённой строке с lookahead `next` (null — конец текста). */
  private decide(line: string, next: string | null): string {
    if (this.fence) {
      if (FENCE_RE.test(line)) this.fence = false;
      return line;
    }
    if (FENCE_RE.test(line)) {
      this.fence = true;
      return line;
    }
    if (isDelimiter(line)) {
      this.tableActive = true;
      return ensureOuterPipes(line);
    }
    const isRow = ROW_RE.test(line) && hasUnescapedPipe(line);
    const nextDelim = next !== null && next.trim() !== "" && isDelimiter(next);
    if (isRow && (nextDelim || this.tableActive)) {
      this.tableActive = true;
      return ensureOuterPipes(line);
    }
    if (line.trim() === "" || !isRow) this.tableActive = false;
    return this.decideInline(line);
  }

  /** Строчные правки без контекста таблицы (заголовок, `1)`). */
  private decideInline(line: string): string {
    return normalizeInlineLine(line);
  }
}

/**
 * Строчная нормализация без контекста: `##Title` → `## Title`, `1)` → `1.`.
 * Двойник `src/ui/md-normalize.ts` (паритет — гвард
 * `tests/ui/md-terminal-parity.test.ts`).
 */
export function normalizeInlineLine(line: string): string {
  if (HEADING_RE.test(line)) return line.replace(HEADING_RE, "$1 $2");
  return line.replace(OL_RE, "$1$2.$3$4");
}

/** Нормализует готовый текст целиком. */
export function normalizeMarkdown(text: string): string {
  const n = new MdNormalizer();
  return n.push(text) + n.flush();
}
